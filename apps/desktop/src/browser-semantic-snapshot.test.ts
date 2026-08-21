import { describe, expect, test } from "bun:test"
import { buildBrowserSemanticTree } from "./browser-semantic-snapshot"

const nodes = [
  { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Example" }, childIds: ["2", "3"] },
  { nodeId: "2", role: { value: "heading" }, name: { value: "Search" }, properties: [{ name: "level", value: { value: 1 } }] },
  { nodeId: "3", role: { value: "generic" }, childIds: ["4", "5", "6"] },
  { nodeId: "4", backendDOMNodeId: 41, role: { value: "textbox" }, name: { value: "Search" } },
  { nodeId: "5", backendDOMNodeId: 42, role: { value: "button" }, name: { value: "Submit" }, childIds: ["7"] },
  { nodeId: "6", backendDOMNodeId: 43, role: { value: "button" }, name: { value: "Submit" }, properties: [{ name: "disabled", value: { value: true } }] },
  { nodeId: "7", role: { value: "StaticText" }, name: { value: "Submit" } },
]

describe("buildBrowserSemanticTree", () => {
  test("renders a compact accessibility tree with stable action refs", () => {
    let next = 1
    const tree = buildBrowserSemanticTree(nodes, { allocateRef: () => `e${next++}` })

    expect(tree.lines.map((line) => line.text).join("\n")).toBe([
      '- document "Example"',
      '  - heading "Search" [level=1]',
      '  - textbox "Search" [ref=e1]',
      '  - button "Submit" [ref=e2]',
      '  - button "Submit" [ref=e3] [disabled]',
    ].join("\n"))
    expect(tree.refs).toEqual([
      { backendNodeId: 41, name: "Search", ref: "e1", role: "textbox" },
      { backendNodeId: 42, name: "Submit", nth: 0, ref: "e2", role: "button" },
      { backendNodeId: 43, name: "Submit", nth: 1, ref: "e3", role: "button" },
    ])
  })

  test("interactiveOnly keeps semantic ancestors and removes unrelated content", () => {
    const tree = buildBrowserSemanticTree(nodes, { interactiveOnly: true, allocateRef: ({ backendNodeId }) => `e${backendNodeId}` })

    expect(tree.lines.map((line) => line.text).join("\n")).toBe([
      '- document "Example"',
      '  - textbox "Search" [ref=e41]',
      '  - button "Submit" [ref=e42]',
      '  - button "Submit" [ref=e43] [disabled]',
    ].join("\n"))
  })

  test("keeps cross-frame nodes in one tree and binds their frame identity", () => {
    const tree = buildBrowserSemanticTree([
      ...nodes,
      { nodeId: "frame-root", __frameId: "frame-2", role: { value: "RootWebArea" }, name: { value: "Embedded" }, childIds: ["frame-button"] },
      { nodeId: "frame-button", __frameId: "frame-2", backendDOMNodeId: 81, role: { value: "button" }, name: { value: "Frame apply" } },
    ], { interactiveOnly: true, allocateRef: ({ backendNodeId }) => `e${backendNodeId}` })

    expect(tree.lines.map((line) => line.text)).toContain('  - button "Frame apply" [ref=e81]')
    expect(tree.refs.find((ref) => ref.ref === "e81")).toMatchObject({ backendNodeId: 81, frameId: "frame-2" })
  })

  test("assigns refs to DOM-supplemented clickable and focusable nodes", () => {
    const tree = buildBrowserSemanticTree([
      { nodeId: "cursor-1", __frameId: "main", backendDOMNodeId: 91, role: { value: "clickable" }, name: { value: "Custom card" } },
      { nodeId: "cursor-2", __frameId: "main", backendDOMNodeId: 92, role: { value: "focusable" }, name: { value: "Custom focus" } },
    ], { interactiveOnly: true, allocateRef: ({ backendNodeId }) => `e${backendNodeId}` })

    expect(tree.lines.map((line) => line.text)).toEqual([
      '- clickable "Custom card" [ref=e91]',
      '- focusable "Custom focus" [ref=e92]',
    ])
  })
})
