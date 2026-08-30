/**
 * DOM 快照归一化管道测试 —— dom-snapshot-session.ts 的纯逻辑部分
 * (文本树解析/清洗/渲染/归一化/iframe 合并)。
 *
 * 参照:02-execution-engine.source.js [SECTION] PlaywrightDomSnapshotSession
 * (tle/nle/kH/bH/rle/ole/ile)。
 */
import { describe, expect, test } from "bun:test"
import {
  cleanSnapshotLine,
  iframeRefFromLine,
  mergeIframeSnapshots,
  normalizeCodexDomSnapshot,
  normalizeSnapshotNode,
  parseSnapshotTree,
  renderSnapshotTree,
} from "../executor/dom-snapshot-session"

describe("parseSnapshotTree", () => {
  test("按缩进构建森林,空行跳过,浅缩进回退到祖先", () => {
    const tree = parseSnapshotTree([
      "- banner",
      "  - heading Ref",
      "",
      "  - generic",
      "    - text hi",
      "- contentinfo",
    ].join("\n"))
    expect(tree.length).toBe(2)
    expect(tree[0]?.line).toBe("- banner")
    expect(tree[0]?.children.length).toBe(2)
    expect(tree[0]?.children[0]?.line).toBe("- heading Ref")
    expect(tree[0]?.children[1]?.children[0]?.line).toBe("- text hi")
    expect(tree[1]?.line).toBe("- contentinfo")
    expect(tree[1]?.children.length).toBe(0)
  })

  test("空输入得到空森林", () => {
    expect(parseSnapshotTree("")).toEqual([])
    expect(parseSnapshotTree("\n \n")).toEqual([])
  })
})

describe("cleanSnapshotLine", () => {
  test("剥离 [ref=…] 与 [cursor=…] 标注,保留其余内容", () => {
    expect(cleanSnapshotLine("- button Submit [ref=e1] [cursor=pointer]:")).toBe("- button Submit:")
    expect(cleanSnapshotLine("- heading Ref [ref=e2]")).toBe("- heading Ref")
    expect(cleanSnapshotLine("- text a [b]")).toBe("- text a [b]")
  })
})

describe("normalizeSnapshotNode", () => {
  test("- img 整支丢弃", () => {
    const node = { line: "- img [ref=e2]:", indent: 2, children: [{ line: "- text x", indent: 4, children: [] }] }
    expect(normalizeSnapshotNode(node)).toEqual([])
  })

  test("- generic/- listitem/- group 以子节点顶替", () => {
    const button = { line: "- button Buy [ref=e3]:", indent: 4, children: [] }
    const generic = { line: "- generic [ref=e1]:", indent: 0, children: [button] }
    expect(normalizeSnapshotNode(generic)).toEqual([{ line: "- button Buy:", indent: 4, children: [] }])

    const listitem = { line: "- listitem [ref=e9]:", indent: 0, children: [{ ...button, line: "- button Cart [ref=e4]:" }] }
    expect(normalizeSnapshotNode(listitem)[0]?.line).toBe("- button Cart:")

    const group = { line: "- group:", indent: 0, children: [{ ...button, line: "- link Home [ref=e5]:" }] }
    expect(normalizeSnapshotNode(group)[0]?.line).toBe("- link Home:")
  })

  test("其余行保留(清洗后),子节点递归归一化", () => {
    const img = { line: "- img [ref=e8]:", indent: 4, children: [] }
    const link = { line: "- link Buy [ref=e3]:", indent: 2, children: [img, { line: "- text Buy", indent: 4, children: [] }] }
    const normalized = normalizeSnapshotNode({ line: "- dialog [ref=e7]:", indent: 0, children: [link] })
    expect(normalized.length).toBe(1)
    expect(normalized[0]?.line).toBe("- dialog:")
    expect(normalized[0]?.children[0]?.line).toBe("- link Buy:")
    expect(normalized[0]?.children[0]?.children.map((node) => node.line)).toEqual(["- text Buy"])
  })
})

describe("renderSnapshotTree", () => {
  test("两空格缩进渲染,空子树不产生空行", () => {
    const tree = [
      { line: "- banner", indent: 0, children: [{ line: "- heading Ref", indent: 2, children: [] }] },
      { line: "- text", indent: 0, children: [] },
    ]
    expect(renderSnapshotTree(tree)).toBe("- banner\n  - heading Ref\n- text")
    expect(renderSnapshotTree([])).toBe("")
  })
})

describe("normalizeCodexDomSnapshot", () => {
  test("非树形文本原样返回", () => {
    expect(normalizeCodexDomSnapshot("plain text")).toBe("plain text")
    expect(normalizeCodexDomSnapshot("line one\nline two")).toBe("line one\nline two")
  })

  test("树形文本经丢弃/扁平化/清洗管线", () => {
    const snapshot = [
      "- generic [ref=e1]:",
      "  - img [ref=e2]:",
      "    - text hidden-child",
      "  - link Buy [ref=e3]:",
      "    - text Buy",
    ].join("\n")
    expect(normalizeCodexDomSnapshot(snapshot)).toBe("- link Buy:\n  - text Buy")
  })
})

describe("iframeRefFromLine", () => {
  test("从 iframe 行提取 ref,其余行返回 undefined", () => {
    expect(iframeRefFromLine("- iframe [ref=e5]:")).toBe("e5")
    expect(iframeRefFromLine("  - iframe [ref=e9]")).toBe("e9")
    expect(iframeRefFromLine("- iframe:")).toBeUndefined()
    expect(iframeRefFromLine("- button [ref=e1]")).toBeUndefined()
    expect(iframeRefFromLine("text - iframe [ref=e1]")).toBeUndefined()
  })
})

describe("mergeIframeSnapshots", () => {
  test("子快照内联到命中 ref 的行下,补齐冒号并按行缩进", () => {
    const parent = ["- banner [ref=e1]:", "  - iframe [ref=e2]", "- text"].join("\n")
    const merged = mergeIframeSnapshots(parent, new Map([["e2", "- heading deep\n  - text d2"]]))
    expect(merged).toBe([
      "- banner [ref=e1]:",
      "  - iframe [ref=e2]:",
      "    - heading deep",
      "      - text d2",
      "- text",
    ].join("\n"))
  })

  test("未命中 ref 的行保持原样,子快照为 undefined 时不合并", () => {
    const parent = "- iframe [ref=e1]:\n- iframe [ref=e2]:"
    const merged = mergeIframeSnapshots(parent, new Map([["e2", undefined]]))
    expect(merged).toBe(parent)
  })
})

describe("合并 + 归一化端到端(capture 的调用顺序)", () => {
  test("父子帧原文先合并,整体做一次归一化(ref 全部清洗)", () => {
    const parent = ["- generic [ref=e0]:", "  - iframe [ref=e7]:", "- contentinfo"].join("\n")
    const child = ["- generic [ref=e6]:", "  - img [ref=e8]:", "  - heading Nested [ref=e9]:"].join("\n")
    const expanded = mergeIframeSnapshots(parent, new Map([["e7", child]]))
    expect(normalizeCodexDomSnapshot(expanded)).toBe([
      "- iframe:",
      "  - heading Nested:",
      "- contentinfo",
    ].join("\n"))
  })
})
