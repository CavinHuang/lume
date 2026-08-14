// packages/sdk/src/agent-resume.test.ts
import { describe, expect, test } from "bun:test"
import { buildResumeContinuations, type DanglingToolUse } from "./interrupt-recovery.js"

const INTERRUPTED_PLACEHOLDER =
  "Error: interrupted before completion; actual state unknown — inspect the workspace before retrying."

describe("buildResumeContinuations", () => {
  const dangling: DanglingToolUse[] = [
    { id: "r1", name: "Read", input: { path: "a" } },
    { id: "w1", name: "Edit", input: { path: "b" } },
  ]

  test("read-only tools replay; side-effect tools get interrupted placeholder", () => {
    const continuations = buildResumeContinuations(dangling, {
      isReadOnly: (name) => name === "Read",
    })
    expect(continuations).toEqual([
      { toolCall: { id: "r1", name: "Read", input: { path: "a" } } },
      {
        toolCall: { id: "w1", name: "Edit", input: { path: "b" } },
        toolResult: {
          type: "tool_result",
          tool_use_id: "w1",
          content: INTERRUPTED_PLACEHOLDER,
          is_error: true,
        },
      },
    ])
  })

  test("unknown tools are treated as side-effect and never replayed", () => {
    const continuations = buildResumeContinuations(
      [{ id: "x1", name: "Mystery", input: {} }],
      { isReadOnly: () => false },
    )
    expect(continuations).toHaveLength(1)
    expect(continuations[0]?.toolResult?.is_error).toBe(true)
    expect(continuations[0]?.toolCall).toEqual({ id: "x1", name: "Mystery", input: {} })
  })

  test("dedupes duplicate tool_call ids keeping the first occurrence", () => {
    const continuations = buildResumeContinuations(
      [
        { id: "dup", name: "Read", input: { path: "first" } },
        { id: "dup", name: "Read", input: { path: "second" } },
      ],
      { isReadOnly: () => true },
    )
    expect(continuations).toEqual([
      { toolCall: { id: "dup", name: "Read", input: { path: "first" } } },
    ])
  })
})
