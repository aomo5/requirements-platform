"""Check fixed handoff labels in native workbench CLI drafts; optionally trace one node."""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path


LABEL_TYPE = "流程对应标签"
DISPLAY_PREFIX = "【对应】"
KEY = re.compile(r"handoff-[a-z0-9]+(?:-[a-z0-9]+)*")
CONTENT = ("name", "type", "required", "condition", "description")


def ref(value):
    return value["entryPath"], value["flowId"], value["nodeId"]


def inventory(bundles):
    nodes, routes, missing, edges = {}, [], [], {}
    for bundle in bundles:
        if bundle.get("format") != "workbench-flow-edit/v1":
            raise ValueError("需要 workbench-flow-edit/v1 格式的 CLI 草稿")
        topic = bundle["entryPath"]
        for flow in bundle["draft"]["workspace"]["flows"]:
            edges[topic, flow["id"]] = {(edge["source"], edge["target"]) for edge in flow.get("edges", [])}
            for node in flow["nodes"]:
                here = (topic, flow["id"], node["id"])
                if here in nodes:
                    raise ValueError(f"重复的流程节点 {here}")
                nodes[here] = node
                for kind, field in (("输出承接", "target"), ("恢复入口", "recovery")):
                    if node.get(field):
                        routes.append((kind, here, ref(node[field]), None))
                if node["type"] == "output" and not node.get("target"):
                    missing.append((here, "出口缺少承接节点"))
                if node.get("source"):
                    routes.append(("输入来源", ref(node["source"]), here, None))
                call = node.get("call")
                if call:
                    entry = ref(call)
                    routes.append(("同步调用", here, entry, here))
                    for item in call["returns"]:
                        source = (*entry[:2], item["outputNodeId"])
                        receiver = (*here[:2], item["targetNodeId"])
                        routes.append(("本次返回", source, receiver, here))
                elif node["type"] == "call":
                    missing.append((here, "调用节点缺少模块入口"))
    module_returns = {}
    for (topic, fid, nid), node in nodes.items():
        if node["type"] == "return":
            module_returns.setdefault((topic, fid), set()).add(nid)
    for here, node in nodes.items():
        call = node.get("call")
        if not call:
            continue
        entry = ref(call)
        if entry not in nodes:
            continue  # check() identifies the missing catalog or endpoint.
        if nodes[entry]["type"] != "input":
            missing.append((here, "公共模块入口类型有误"))
        mappings = call["returns"]
        ids = [item["outputNodeId"] for item in mappings]
        if set(ids) != module_returns.get(entry[:2], set()) or len(ids) != len(set(ids)):
            missing.append((here, "调用点未恰好覆盖每个模块返回"))
        receivers = {item["targetNodeId"] for item in mappings}
        physical = {dest for source, dest in edges[here[:2]] if source == here[2]}
        if receivers != physical:
            missing.append((here, "返回映射与调用节点实际出边不一致"))
    return nodes, routes, missing


def check(nodes, routes, missing):
    rows, definitions, names, matched = {}, {}, {}, set()
    problems = [f"{'/'.join(here)}：{reason}" for here, reason in missing]
    for here, node in nodes.items():
        for side in ("inputs", "outputs"):
            tags = rows[here, side] = {}
            for row in node.get("contract", {}).get(side, []):
                key, name = row["id"], row["name"]
                if not (row.get("type") == LABEL_TYPE or name.startswith(DISPLAY_PREFIX)):
                    continue
                if not KEY.fullmatch(key) or row.get("type") != LABEL_TYPE or not name.startswith(DISPLAY_PREFIX) or not name[len(DISPLAY_PREFIX):].strip():
                    problems.append(f"{'/'.join(here)}：对应标签格式有误 {key} {name}")
                if not row.get("description", "").strip():
                    problems.append(f"{'/'.join(here)}：标签缺少对结果边界的说明 {key}")
                if key in tags:
                    problems.append(f"{'/'.join(here)}：{side} 标签重复 {key}")
                tags[key] = row
                scope = (here[0], key)
                signature = tuple(row.get(field, "") for field in CONTENT)
                if definitions.setdefault(scope, signature) != signature:
                    problems.append(f"{'/'.join(here)}：标签 {key} 的名称、条件或含义不一致")
                if names.setdefault((here[0], name), key) != key:
                    problems.append(f"{'/'.join(here)}：同一显示名称用了多个键 {name}")
    resolved = []
    for kind, source, receiver, caller in routes:
        if source not in nodes or receiver not in nodes:
            problems.append(f"{kind} 缺少节点或关联主题草稿：{source} → {receiver}")
            continue
        if kind == "输出承接" and nodes[source]["type"] == "output" and nodes[receiver]["type"] == "output":
            problems.append(f"跨图出口直连出口：{'/'.join(source)} → {'/'.join(receiver)}。先接入目标图，再沿本图连线转出。")
        out = rows[source, "outputs"]
        incoming = rows[receiver, "inputs"]
        shared = sorted(out.keys() & incoming.keys())
        if len(shared) != 1:
            problems.append(f"{kind} {'/'.join(source)} → {'/'.join(receiver)}：应有一个匹配标签，找到 {shared}")
        for key in shared:
            if any(out[key].get(field, "") != incoming[key].get(field, "") for field in CONTENT):
                problems.append(f"{kind} {'/'.join(source)} → {'/'.join(receiver)}：{key} 两端内容不一致")
            for row, peer in ((out[key], receiver), (incoming[key], source)):
                locator = row.get("source", "")
                if f"[{peer[2]}]" not in locator or (kind == "本次返回" and f"[{caller[2]}]" not in locator):
                    problems.append(f"{kind} {source} → {receiver}：{key} 来源栏缺少对端或本次调用节点")
            matched.update(((source, "outputs", key), (receiver, "inputs", key)))
            resolved.append((kind, source, receiver, caller, key, out[key]["name"]))
    for (here, side), tags in rows.items():
        for key in tags:
            if (here, side, key) not in matched:
                problems.append(f"{'/'.join(here)}：{side} 的 {key} 没有原生关系相接")
    return resolved, sorted(set(problems))


def explicit_input_issues(nodes, routes, modules):
    issues = []
    for kind, origin, receiver, _ in routes:
        if kind != "输出承接" or origin not in nodes or receiver not in nodes:
            continue
        target = nodes[receiver]
        shape = target["type"]
        if nodes[origin]["type"] != "output" or shape == "output":
            continue  # The standard check already reports an output connected to an output.
        if shape == "event" and target.get("eventType") in {"timer", "message", "response", "manual"}:
            continue
        if shape != "input":
            issue = f"落点为 {shape}，请显式接入后再到原处理位置，或标明真实事件类型"
        elif receiver[:2] not in modules and (not target.get("source") or ref(target["source"]) != origin):
            issue = "接收入口的来源未指回本出口，请核实同一结果的各条来路"
        else:
            continue
        issues.append(f"显式入口：{'/'.join(origin)} → {'/'.join(receiver)}：{issue}")
    return issues


def fill_receivers(nodes, routes, flow_names):
    """Copy a reviewed, unambiguous producer label; never invent a meaning."""
    for _, producer, receiver, _ in routes:
        if producer not in nodes or receiver not in nodes:
            continue
        output = [r for r in nodes[producer].get("contract", {}).get("outputs", []) if r.get("type") == LABEL_TYPE]
        if len(output) != 1:
            continue
        node = nodes[receiver]
        inputs = node.setdefault("contract", {}).setdefault("inputs", [])
        if any(r["id"] == output[0]["id"] for r in inputs):
            continue
        if len(inputs) >= 50:
            raise ValueError(f"{receiver} 输入字段已满，请核对后再保存")
        inputs.append(dict(output[0]))
    locations = {}
    for kind, producer, receiver, caller in routes:
        if producer not in nodes or receiver not in nodes:
            continue
        output = {r["id"]: r for r in nodes[producer].get("contract", {}).get("outputs", []) if r.get("type") == LABEL_TYPE}
        inputs = {r["id"]: r for r in nodes[receiver].get("contract", {}).get("inputs", []) if r.get("type") == LABEL_TYPE}
        keys = output.keys() & inputs.keys()
        if len(keys) != 1:
            continue
        key, = keys
        for owner, direction, peer, row in ((producer, "outputs", receiver, output[key]), (receiver, "inputs", producer, inputs[key])):
            position = flow_names[peer[:2]] + " · " + nodes[peer]["label"].replace("\n", "／") + f" [{peer[2]}]"
            if kind == "本次返回":
                position += "（调用处 " + nodes[caller]["label"].replace("\n", "／") + f" [{caller[2]}]）"
            _, names = locations.setdefault((owner, direction, key), (row, set()))
            names.add(position)
    for row, names in locations.values():
        location = "\n".join(sorted(names))
        if len(location) > 1000:
            raise ValueError(f'{row["id"]} 来源栏超过1000字，请核查分组或缩短端点名称')
        row["source"] = location


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path, help="CLI pull 的草稿。跨主题时一并传入关联主题。")
    parser.add_argument("--explicit-inputs", action="store_true", help="逐出口走图时检查专用接收入口、已分类事件与反向来源")
    parser.add_argument("--at", nargs=2, metavar=("FLOW", "NODE"), help="列出该节点流入、流出和本调用点的返回")
    parser.add_argument("--out", type=Path, help="把源端已定的唯一标签补至接收端，仅写入一个新草稿")
    parser.add_argument("--report", type=Path, help="另存逐对结果与问题清单")
    args = parser.parse_args()
    try:
        bundles = [json.loads(path.read_text(encoding="utf-8")) for path in args.files]
        nodes, routes, missing = inventory(bundles)
        if args.out:
            if len(bundles) != 1:
                raise ValueError("--out 仅用于单个主题草稿")
            names = {(b["entryPath"], f["id"]): f["name"] for b in bundles for f in b["draft"]["workspace"]["flows"]}
            fill_receivers(nodes, routes, names)
        resolved, issues = check(nodes, routes, missing)
        if args.explicit_inputs:
            modules = {(b["entryPath"], f["id"]) for b in bundles
                       for f in b["draft"]["workspace"]["flows"] if f.get("kind") == "module"}
            issues = sorted(set(issues + explicit_input_issues(nodes, routes, modules)))
        if args.report and (args.report.resolve() in {p.resolve() for p in args.files}
                            or (args.out and args.report.resolve() == args.out.resolve())):
            raise ValueError("--report 请选用与草稿不同的文件")
        if args.report:
            with args.report.open("x", encoding="utf-8") as report:
                json.dump({"relations": resolved, "issues": issues}, report, ensure_ascii=False, indent=2)
        if args.out and not issues:
            with args.out.open("x", encoding="utf-8") as out:
                json.dump(bundles[0], out, ensure_ascii=False, indent=2)
        if args.at:
            matches = [here for here in nodes if here[1:] == tuple(args.at)]
            if len(matches) != 1:
                raise ValueError(f"定位应唯一，实际找到 {len(matches)} 个 {args.at}")
            focus = matches[0]
            def endpoint(here):
                return f"{here[0]}/{here[1]}/{here[2]} " + nodes[here]["label"].replace("\n", " / ")
            for kind, src, dst, caller, key, name in resolved:
                if focus in (src, dst, caller):
                    context = f"  调用点 {endpoint(caller)}" if kind == "本次返回" else ""
                    print(f"{name} [{key}]  {kind}  {endpoint(src)} → {endpoint(dst)}{context}")
        count = Counter(route[0] for route in routes)
        pairs = len({(src, dst, caller if kind == "本次返回" else None)
                     for kind, src, dst, caller in routes})
        print("原生声明 " + "、".join(f"{kind} {n}" for kind, n in sorted(count.items())))
        print(f"去重后 {pairs} 对（返回按调用点区分），问题 {len(issues)} 项")
        for issue in issues:
            print(issue, file=sys.stderr)
        return 1 if issues else 0
    except (OSError, KeyError, ValueError, TypeError) as exc:
        parser.exit(2, f"无法核验：{exc}\n")


if __name__ == "__main__":
    sys.exit(main())
