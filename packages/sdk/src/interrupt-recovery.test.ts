// packages/sdk/src/interrupt-recovery.test.ts
import { describe, expect, test } from "bun:test"
import { detectDanglingToolUses } from "./interrupt-recovery.js"

const assistantWithTools = (id: string, name: string, input: unknown) => ({
  role: "assistant" as const,
  content: [{ type: "tool_use" as const, id, name, input }],
})
const toolResultFor = (id: string, content = "ok") => ({
  role: "user" as const,
  content: [{ type: "tool_result" as const, tool_use_id: id, content }],
})

describe("detectDanglingToolUses", () => {
  test("returns unanswered tool_use from the trailing assistant", () => {
    const messages: any[] = [
      { role: "user", content: "do it" },
      assistantWithTools("t1", "Read", { path: "a.ts" }),
      toolResultFor("t1"),
      assistantWithTools("t2", "Bash", { command: "ls" }),
      // t2 无 tool_result → 悬空
    ]
    expect(detectDanglingToolUses(messages)).toEqual([
      { id: "t2", name: "Bash", input: { command: "ls" } },
    ])
  })

  test("returns empty when the conversation ends cleanly", () => {
    const messages: any[] = [
      { role: "user", content: "do it" },
      assistantWithTools("t1", "Read", { path: "a.ts" }),
      toolResultFor("t1"),
    ]
    expect(detectDanglingToolUses(messages)).toEqual([])
  })

  test("returns empty when the trailing assistant has no tool_use", () => {
    const messages: any[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    expect(detectDanglingToolUses(messages)).toEqual([])
  })

  test("ignores dangling tool_use in earlier assistants (historical damage)", () => {
    const messages: any[] = [
      assistantWithTools("t0", "Read", { path: "old.ts" }),
      // t0 悬空但被后面的 assistant 覆盖 → 历史损坏,忽略
      assistantWithTools("t1", "Read", { path: "a.ts" }),
      toolResultFor("t1"),
    ]
    expect(detectDanglingToolUses(messages)).toEqual([])
  })

  test("handles multiple dangling tool_use in one assistant", () => {
    const messages: any[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "Read", input: { path: "a" } },
          { type: "tool_use", id: "b", name: "Edit", input: { path: "b" } },
        ],
      },
      toolResultFor("a"),
      // b 悬空
    ]
    expect(detectDanglingToolUses(messages)).toEqual([
      { id: "b", name: "Edit", input: { path: "b" } },
    ])
  })
})
