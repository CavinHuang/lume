import { describe, expect, test } from "bun:test"
import { buildBrowserSemanticTree, reusableSemanticFrameState, sameSemanticFrameState, SEMANTIC_SNAPSHOT_REUSE_TTL_MS, type BrowserSemanticFrameRevision } from "./browser-semantic-snapshot"

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

  test("tracks ref ancestry for scoped subtree reads", () => {
    const tree = buildBrowserSemanticTree([
      { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["list"] },
      { nodeId: "list", backendDOMNodeId: 91, role: { value: "listbox" }, name: { value: "Projects" }, childIds: ["option"] },
      { nodeId: "option", backendDOMNodeId: 92, role: { value: "option" }, name: { value: "Lume" } },
    ], { allocateRef: ({ backendNodeId }) => `e${backendNodeId}` })

    expect(tree.lines.find((line) => line.ref === "e91")?.scopeRefs).toEqual(["e91"])
    expect(tree.lines.find((line) => line.ref === "e92")?.scopeRefs).toEqual(["e91", "e92"])
  })
})

describe("semantic snapshot frame-state reuse (#604)", () => {
  const frame = (overrides: Partial<BrowserSemanticFrameRevision> = {}): BrowserSemanticFrameRevision => ({
    frameId: "main",
    frameRevision: "7|0-0-0",
    loaderId: "loader-1",
    ...overrides,
  })
  const frames = [frame(), frame({ frameId: "iframe-1", frameRevision: "3|1-0-5", loaderId: "loader-2" })]
  const cachedAt = 1_000

  test("reusable while every frame is trusted and within the TTL", () => {
    expect(reusableSemanticFrameState(frames, cachedAt, cachedAt + SEMANTIC_SNAPSHOT_REUSE_TTL_MS)).toBe(true)
    expect(reusableSemanticFrameState(frames, cachedAt, cachedAt + SEMANTIC_SNAPSHOT_REUSE_TTL_MS + 1)).toBe(false)
  })

  test("unreusable when any frame revision is untrustworthy (null)", () => {
    expect(reusableSemanticFrameState([frame({ frameRevision: null })], cachedAt, cachedAt)).toBe(false)
    expect(reusableSemanticFrameState([frame(), frame({ frameRevision: null })], cachedAt, cachedAt)).toBe(false)
  })

  test("unreusable with empty state or missing frame loader identity", () => {
    expect(reusableSemanticFrameState([], cachedAt, cachedAt)).toBe(false)
    expect(reusableSemanticFrameState([frame({ loaderId: "" })], cachedAt, cachedAt)).toBe(false)
  })

  test("sameSemanticFrameState compares frame identity and revision pairwise", () => {
    expect(sameSemanticFrameState(frames, [frame(), frame({ frameId: "iframe-1", frameRevision: "3|1-0-5", loaderId: "loader-2" })])).toBe(true)
    expect(sameSemanticFrameState(frames, [frame(), frame({ frameId: "iframe-1", frameRevision: "4|1-0-5", loaderId: "loader-2" })])).toBe(false)
    expect(sameSemanticFrameState(frames, [frame(), frame({ frameId: "iframe-2", frameRevision: "3|1-0-5", loaderId: "loader-2" })])).toBe(false)
    expect(sameSemanticFrameState(frames, [frame()])).toBe(false)
  })
})
