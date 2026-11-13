"""List the whole topic and its declared cross-flow relationships before editing."""
import argparse
import json
from pathlib import Path


def outline(bundle, focus):
    topic = bundle["entryPath"]
    draft = bundle["draft"]
    workspace = draft["workspace"]
    flows = {flow["id"]: flow for flow in workspace["flows"]}
    if focus and focus not in flows:
        raise ValueError(f"未找到流程 {focus}")

    def endpoint(ref):
        flow_id = ref["flowId"]
        name = flows.get(flow_id, {}).get("name", "") if ref["entryPath"] == topic else ""
        prefix = "" if ref["entryPath"] == topic else ref["entryPath"] + " / "
        return f"{prefix}{name} [{flow_id}]" + ("/" + ref["nodeId"] if ref.get("nodeId") else "")

    def relation(kind, origin, destination, owner=None):
        if focus and not any(ref["entryPath"] == topic and ref["flowId"] == focus
                             for ref in (origin, destination)):
            return
        line = f"  {kind}  {endpoint(origin)} → {endpoint(destination)}"
        print(line + (f"  （调用点 {owner}）" if owner else ""))

    print(f'{topic}  图版本 {workspace["revision"]} / 说明版本 {draft["annotations"]["revision"]}')
    print("全主题目录")
    for flow in flows.values():
        print(f'  {flow["name"]} [{flow["id"]}]  {len(flow["nodes"])} 节点 / {len(flow["edges"])} 连线')
    for external in workspace.get("references", []):
        print(f"  外部流程引用  {endpoint(external)}")
    print("指定流程在全主题声明的关系" if focus else "全主题声明的关系")
    for flow in flows.values():
        here = {"entryPath": topic, "flowId": flow["id"]}
        if flow.get("parent"):
            relation("归属展开", flow["parent"], here)
        for node in flow["nodes"]:
            local = dict(here, nodeId=node["id"])
            if node.get("source"):
                relation("输入来源", node["source"], local)
            for field, kind in (("target", "输出承接"), ("recovery", "恢复入口")):
                if node.get(field):
                    relation(kind, local, node[field])
            call = node.get("call")
            if call:
                relation("同步调用", local, call)
                for result in call["returns"]:
                    relation("本次返回", dict(call, nodeId=result["outputNodeId"]),
                             dict(here, nodeId=result["targetNodeId"]), node["id"])
            elif node["type"] == "call" and (not focus or focus == flow["id"]):
                print(f"  调用目标待补  {endpoint(local)}")
    print("按当前草稿列举显式关系。共享字段、代码和配置里的隐式接手、跨主题反向引用需另查。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="workbench flow pull 生成的草稿")
    parser.add_argument("--flow", help="仍列出全主题目录，仅展开与该流程直接相连的关系")
    args = parser.parse_args()
    try:
        bundle = json.loads(args.file.read_text(encoding="utf-8"))
        if bundle["format"] != "workbench-flow-edit/v1":
            raise ValueError("需要 workbench-flow-edit/v1 草稿")
        outline(bundle, args.flow)
    except (OSError, KeyError, ValueError, TypeError) as exc:
        parser.exit(1, f"无法生成关系清单：{exc}\n")


if __name__ == "__main__":
    main()
