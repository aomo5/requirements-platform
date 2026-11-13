#!/usr/bin/env python3
"""Query and build the local design system. Standard library only; no network."""
import argparse
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GROUPS = {
    "overview": "开始", "color": "基础", "typography": "基础", "geometry": "基础", "icons": "基础",
    "button": "组件", "input": "组件", "navigation": "组件", "panel": "组件", "feedback": "组件",
    "canvas": "交互", "links": "交互", "creation": "交互", "states": "交互",
    "writing": "质量", "accessibility": "质量", "review": "质量", "sources": "质量",
}


def data():
    return json.loads((ROOT / "assets/tokens.json").read_text())


def resolve(name, tokens, seen=()):
    if name in seen:
        raise ValueError("Token reference cycle: " + " → ".join((*seen, name)))
    value = tokens[name]["value"]
    return re.sub(r"\{([\w-]+)\}", lambda m: resolve(m[1], tokens, (*seen, name)), value)


def sections():
    result = []
    for file in ("foundations", "components", "patterns", "quality", "sources"):
        source = ROOT / f"references/{file}.md"
        parts = re.split(r"^## ([a-z-]+) · (.+)$", source.read_text(), flags=re.M)
        for i in range(1, len(parts), 3):
            result.append({"id": parts[i], "title": parts[i+1], "group": GROUPS[parts[i]],
                           "body": parts[i+2].strip(), "source": str(source.relative_to(ROOT))})
    return result


def inline(value):
    value = html.escape(value)
    value = re.sub(r"`([^`]+)`", r"<code>\1</code>", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", value)
    return re.sub(r"\[([^\]]+)\]\((https://[^\s)]+)\)", r'<a href="\2" target="_blank" rel="noreferrer">\1</a>', value)


def markdown(source, section_id):
    # The authoring format uses paragraphs, h3 headings, flat lists and tables.
    # Escape raw HTML; unsupported Markdown remains readable text.
    lines, out, i, heading = source.splitlines(), [], 0, 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        if line.startswith("### "):
            heading += 1
            out.append(f'<h2 id="{section_id}-{heading}">{inline(line[4:])}</h2>')
            i += 1
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            out.append('<div class="table-wrap"><table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in rows[0]) + '</tr></thead><tbody>')
            for row in rows[2:]:
                out.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in row) + '</tr>')
            out.append('</tbody></table></div>')
        elif line.startswith("- "):
            out.append('<ul>')
            while i < len(lines) and lines[i].strip().startswith("- "):
                out.append('<li>' + inline(lines[i].strip()[2:]) + '</li>')
                i += 1
            out.append('</ul>')
        else:
            paragraph = [line]
            i += 1
            while i < len(lines) and lines[i].strip() and not lines[i].startswith(("### ", "|", "- ")):
                paragraph.append(lines[i].strip())
                i += 1
            out.append('<p>' + inline(' '.join(paragraph)) + '</p>')
    return '\n'.join(out)


def luminance(color):
    rgb = [int(color[j:j+2], 16)/255 for j in (1, 3, 5)]
    linear = [v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4 for v in rgb]
    return sum(a*b for a, b in zip(linear, (.2126, .7152, .0722)))


def validate():
    config, checks = data(), []
    tokens = config["tokens"]
    for key in tokens:
        if not re.fullmatch(r"[a-z][a-z0-9-]+", key):
            raise ValueError(f"Invalid token name: {key}")
        resolve(key, tokens)
    for fore, back, minimum in config["contrastPairs"]:
        a, b = sorted((luminance(resolve(fore, tokens)), luminance(resolve(back, tokens))))
        ratio = (b+.05)/(a+.05)
        checks.append({"foreground": fore, "background": back, "ratio": round(ratio, 2), "minimum": minimum})
        if ratio < minimum:
            raise ValueError(f"Contrast failed: {fore}/{back}: {ratio:.2f} < {minimum}")
    docs = sections()
    if len({s['id'] for s in docs}) != len(docs) or set(GROUPS) != {s['id'] for s in docs}:
        raise ValueError("Missing or duplicate sections")
    for source in [ROOT / "SKILL.md", *ROOT.glob("references/*.md")]:
        for target in re.findall(r"\]\(([^)]+)\)", source.read_text()):
            if not target.startswith(("https://", "#")) and not (source.parent / target.split('#')[0]).exists():
                raise ValueError(f"Missing reference: {source.name}: {target}")
    return {"valid": True, "version": config["version"], "tokens": len(tokens), "sections": len(docs), "contrast": checks}


def build(destination, css_destination=None):
    report = validate()
    config, docs = data(), sections()
    tokens = config["tokens"]
    css = '/* Generated from tokens.json; do not edit. */\n:root{\n' + '\n'.join(f'  --wb-{key}: {resolve(key, tokens)};' for key in tokens) + '\n}\n'
    (ROOT / "assets/tokens.css").write_text(css)
    if css_destination:
        css_path = Path(css_destination).expanduser().resolve()
        if css_path.suffix != ".css":
            raise ValueError("CSS output must use a .css extension")
        css_path.parent.mkdir(parents=True, exist_ok=True)
        css_path.write_text(css)
    nav, content, last = [], [], None
    for s in docs:
        if s['group'] != last:
            nav.append(f'<div class="nav-group">{s["group"]}</div>')
            last = s['group']
        nav.append(f'<a href="#{s["id"]}" data-nav="{s["id"]}">{html.escape(s["title"])}</a>')
        content.append(f'<article id="{s["id"]}" class="doc" hidden><header class="doc-head"><div class="eyebrow">{s["group"]}</div><h1 tabindex="-1">{html.escape(s["title"])}</h1></header><div class="specimen" data-example="{s["id"]}"></div><div class="prose">{markdown(s["body"], s["id"])}</div></article>')
    payload = json.dumps({"version": config["version"], "tokens": {k: {**v, "resolved": resolve(k, tokens)} for k,v in tokens.items()}, "sections": [{k:v for k,v in s.items() if k != 'body'} for s in docs]}, ensure_ascii=False).replace('</', '<\\/')
    template = (ROOT / "assets/handbook.template.html").read_text()
    for key, value in {"__TOKEN_CSS__": css, "__NAV__": ''.join(nav), "__CONTENT__": ''.join(content), "__DATA__": payload}.items():
        template = template.replace(key, value)
    destination = Path(destination).expanduser().resolve()
    if destination == ROOT / "assets/handbook.template.html":
        raise ValueError("Output must not overwrite the template")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(template)
    return {"output": str(destination), "version": config["version"], "sections": report["sections"], "tokens": report["tokens"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    query = sub.add_parser("query"); query.add_argument("term")
    token = sub.add_parser("tokens"); token.add_argument("term", nargs="?", default="")
    sub.add_parser("validate")
    export = sub.add_parser("build"); export.add_argument("--out", required=True); export.add_argument("--css-out")
    args = parser.parse_args()
    if args.command == 'validate':
        result = validate()
    elif args.command == 'build':
        result = build(args.out, args.css_out)
    elif args.command == 'tokens':
        values = data()['tokens']; q = args.term.lower()
        result = {k: {**v, "resolved": resolve(k, values), "css": f"var(--wb-{k})"} for k,v in values.items() if q in k or q in v['use'].lower() or q == v['group']}
    else:
        docs = sections(); q = args.term.lower()
        result = [s for s in docs if q == s['id'] or q == s['title']] or [s for s in docs if q in (s['title'] + s['body']).lower()]
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
