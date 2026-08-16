// packages/sdk/src/events/lifecycle-projector.test.ts
import { describe, expect, test } from "bun:test"
import { projectLifecycle } from "./lifecycle-projector.js"
import type { SDKMessage } from "../types.js"

/** 用固定消息序列驱动 projector,收集骨架事件 */
async function run(messages: SDKMessage[]): Promise<any[]> {
  async function* input() { for (const m of messages) yield m }
  const out: any[] = []
  for await (const ev of projectLifecycle(input())) out.push(ev)
  return out
}

const streamTextDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  parent_tool_use_id: null,
})
const assistantWithTool = (uuid: string, toolId = "t1") => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", content: [
    { type: "text", text: "hi" },
    { type: "tool_use", id: toolId, name: "Read", input: {} },
  ] },
})
const toolResult = (id: string) => ({
  type: "tool_result",
  result: { tool_use_id: id, tool_name: "Read", output: "ok", is_error: false },
})

describe("projectLifecycle", () => {
  test("single turn with tool: full skeleton, turn.end self-contained", async () => {
    const events = await run([
      streamTextDelta("he") as any,
      streamTextDelta("llo") as any,
      assistantWithTool("turn-a") as any,
      toolResult("t1") as any,
      { type: "result", subtype: "success", num_turns: 1 } as any,
    ])

    const kinds = events.map((e) => `${e.kind}.${e.phase}`)
    expect(kinds).toEqual([
      "run.start", "turn.start", "message.start",
      "message.update", "message.update", "message.end",
      "tool.start", "tool.end", "turn.end", "run.end",
    ])
    const turnEnd = events.find((e) => e.phase === "end" && e.kind === "turn")
    expect(turnEnd.turnId).toBe("turn-1")
    expect(turnEnd.detail.toolResults).toEqual([
      expect.objectContaining({ tool_use_id: "t1" }),
    ])
    expect(turnEnd.detail.assistantMessage.content).toHaveLength(2)
    const runEnd = events.at(-1)
    expect(runEnd.detail).toEqual(expect.objectContaining({ stopReason: "end_turn", numTurns: 1 }))
  })

  test("message.update carries folded cumulative partial", async () => {
    const events = await run([
      streamTextDelta("he") as any, streamTextDelta("llo") as any,
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } as any,
    ])
    const updates = events.filter((e) => e.phase === "update")
    expect(updates[0].detail.partial.text).toBe("he")
    expect(updates[1].detail.partial.text).toBe("hello")
    expect(updates[1].detail.delta?.delta?.type).toBe("text_delta")
  })

  test("no-tool assistant: turn.end immediately after message.end", async () => {
    const events = await run([
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } } as any,
    ])
    // 无流式退化:turn.start→message.start→message.end→turn.end 四连发(无 run.end,流未结束)
    expect(events.map((e) => `${e.kind}.${e.phase}`)).toEqual([
      "run.start", "turn.start", "message.start", "message.end", "turn.end",
    ])
  })

  test("error assistant: fallback chain message.end(error)→turn.end(∅)→run.end", async () => {
    const events = await run([
      streamTextDelta("par") as any,
      { type: "assistant", uuid: "u1", error: "server_error",
        message: { role: "assistant", content: [{ type: "text", text: "par" }] } } as any,
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1 } as any,
    ])
    const kinds = events.map((e) => `${e.kind}.${e.phase}`)
    expect(kinds).toEqual([
      "run.start", "turn.start", "message.start", "message.update",
      "message.end", "turn.end", "run.end",
    ])
    const msgEnd = events.find((e) => e.kind === "message" && e.phase === "end")
    expect(msgEnd.detail.error).toBe("server_error")
    expect(events.find((e) => e.kind === "turn" && e.phase === "end").detail.toolResults).toEqual([])
  })

  test("subagent events are skipped", async () => {
    const events = await run([
      { type: "assistant", subagent_run_id: "sub-1", uuid: "s-u",
        message: { role: "assistant", content: [] } } as any,
      { type: "assistant", uuid: "main-1",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } as any,
    ])
    expect(events.every((e) => e.turnId !== "s-u")).toBe(true)
    // Main-stream turn gets the positional fallback id (turnId never uses uuid).
    expect(events.some((e) => e.turnId === "turn-1")).toBe(true)
  })

  test("multi-turn: turn boundary waits for full tool pairing per turn", async () => {
    const events = await run([
      assistantWithTool("t-a") as any,
      toolResult("t1") as any,
      assistantWithTool("t-b", "t2") as any,
      toolResult("t2") as any,
      { type: "result", subtype: "success", num_turns: 2 } as any,
    ])
    const turnEnds = events.filter((e) => e.kind === "turn" && e.phase === "end")
    expect(turnEnds.map((e) => e.turnId)).toEqual(["turn-1", "turn-2"])
    expect(turnEnds[0].detail.toolResults[0].tool_use_id).toBe("t1")
    expect(turnEnds[1].detail.toolResults[0].tool_use_id).toBe("t2")
    expect(events.at(-1).detail.numTurns).toBe(2)
  })

  test("two tool_use blocks: tool.start×2 after message.end in content order", async () => {
    const events = await run([
      streamTextDelta("he") as any,
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "Read", input: { path: "a" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { cmd: "ls" } },
      ] } } as any,
      toolResult("t1") as any,
      toolResult("t2") as any,
      { type: "result", subtype: "success", num_turns: 1 } as any,
    ])
    expect(events.map((e) => `${e.kind}.${e.phase}`)).toEqual([
      "run.start", "turn.start", "message.start", "message.update",
      "message.end", "tool.start", "tool.start",
      "tool.end", "tool.end", "turn.end", "run.end",
    ])
    const starts = events.filter((e) => e.kind === "tool" && e.phase === "start")
    expect(starts.map((e) => e.detail.toolCallId)).toEqual(["t1", "t2"])
    expect(starts.map((e) => e.detail.input)).toEqual([{ path: "a" }, { cmd: "ls" }])
    expect(starts.every((e) => e.turnId === "turn-1")).toBe(true)
  })

  test("tool_result → tool.end passes through output and _meta, before turn.end", async () => {
    const events = await run([
      assistantWithTool("u1") as any,
      { type: "tool_result", result: {
        tool_use_id: "t1", tool_name: "Read", output: "file body",
        is_error: false, _meta: { execution: { durationMs: 12 } },
      } } as any,
    ])
    const toolEnd = events.find((e) => e.kind === "tool" && e.phase === "end")
    expect(toolEnd.detail).toEqual({
      type: "tool.end", toolCallId: "t1", toolName: "Read",
      isError: false, output: "file body", meta: { execution: { durationMs: 12 } },
    })
    expect(events.findIndex((e) => e.kind === "tool" && e.phase === "end"))
      .toBeLessThan(events.findIndex((e) => e.kind === "turn" && e.phase === "end"))
  })

  test("failed tool_result → tool.end isError=true", async () => {
    const events = await run([
      assistantWithTool("u1") as any,
      { type: "tool_result", result: {
        tool_use_id: "t1", tool_name: "Bash", output: "boom", is_error: true,
      } } as any,
    ])
    const toolEnd = events.find((e) => e.kind === "tool" && e.phase === "end")
    expect(toolEnd.detail.isError).toBe(true)
  })

  test("error assistant with tool_use: no tool.start (tools never ran)", async () => {
    const events = await run([
      { type: "assistant", uuid: "u1", error: "server_error",
        message: { role: "assistant", content: [
          { type: "text", text: "par" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ] } } as any,
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1 } as any,
    ])
    expect(events.map((e) => `${e.kind}.${e.phase}`)).toEqual([
      "run.start", "turn.start", "message.start", "message.end", "turn.end", "run.end",
    ])
  })

  test("duplicate assistant with same tool_use id in open turn: tool.start emitted once", async () => {
    const events = await run([
      assistantWithTool("u1") as any,
      assistantWithTool("u1-replay") as any, // same default toolId "t1"
      toolResult("t1") as any,
    ])
    const starts = events.filter((e) => e.kind === "tool" && e.phase === "start")
    expect(starts).toHaveLength(1)
    expect(starts[0].detail.toolCallId).toBe("t1")
  })

  test("thinking_delta passes through as update without folding into partial", async () => {
    const thinkingDelta = {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } },
      parent_tool_use_id: null,
    }
    const events = await run([
      streamTextDelta("he") as any,
      thinkingDelta as any,
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "he" }] } } as any,
    ])
    const updates = events.filter((e) => e.phase === "update")
    expect(updates).toHaveLength(2)
    expect(updates[1].detail.delta?.delta?.type).toBe("thinking_delta")
    // Batch 1: thinking is not folded — no toolUses slot, no thinking accumulation.
    expect(updates[1].detail.partial.toolUses).toEqual([])
    expect(updates[1].detail.partial.text).toBe("he")
  })
})
