// packages/sdk/src/events/lifecycle-projector.test.ts
import { describe, expect, test } from "bun:test"
import { projectLifecycle } from "./lifecycle-projector.js"
import type { SDKMessage } from "../types.js"

/** 用固定消息序列驱动 projector,收集骨架事件 */
async function run(messages: SDKMessage[], options?: { runId?: string }): Promise<any[]> {
  async function* input() { for (const m of messages) yield m }
  const out: any[] = []
  for await (const ev of projectLifecycle(input(), options)) out.push(ev)
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
  test("options.runId 传入:全部骨架事件 runId=传入值(Lume runId 贯穿)", async () => {
    const events = await run([
      streamTextDelta("he") as any,
      assistantWithTool("turn-a") as any,
      toolResult("t1") as any,
      { type: "result", subtype: "success", num_turns: 1 } as any,
    ], { runId: "lume-run-1" })

    expect(events.length).toBeGreaterThan(0)
    expect(new Set(events.map((e) => e.runId))).toEqual(new Set(["lume-run-1"]))
    // run.start/run.end 等全部骨架事件与领域事件同域
    expect(events.find((e) => e.kind === "run" && e.phase === "start")!.runId).toBe("lume-run-1")
    expect(events.find((e) => e.kind === "run" && e.phase === "end")!.runId).toBe("lume-run-1")
  })

  test("options 缺省:回落自产 UUID,全事件同域(向后兼容)", async () => {
    const events = await run([
      streamTextDelta("he") as any,
      assistantWithTool("turn-a") as any,
      toolResult("t1") as any,
      { type: "result", subtype: "success", num_turns: 1 } as any,
    ])

    const runIds = new Set(events.map((e) => e.runId))
    expect(runIds.size).toBe(1)
    expect(runIds.values().next().value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

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

  test("result.errorCode → run.end detail 透传(#472 guard stop 来源区分)", async () => {
    const events = await run([
      streamTextDelta("he") as any,
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } as any,
      { type: "result", subtype: "error_completion_guard", is_error: true, num_turns: 1, errorCode: "verification_inconclusive" } as any,
    ])
    const runEnd = events.at(-1)
    expect(runEnd.kind).toBe("run")
    expect(runEnd.phase).toBe("end")
    expect(runEnd.detail.stopReason).toBe("error_completion_guard")
    expect(runEnd.detail.isError).toBe(true)
    expect(runEnd.detail.errorCode).toBe("verification_inconclusive")
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
    // 无流式退化:turn.start→message.start→message.end→turn.end 四连发;批次5 起流终止
    // 无 result 时补 run.end(aborted) 终值
    expect(events.map((e) => `${e.kind}.${e.phase}`)).toEqual([
      "run.start", "turn.start", "message.start", "message.end", "turn.end", "run.end",
    ])
    expect(events.at(-1).detail.stopReason).toBe("aborted")
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

  // ---- batch 4: domain events (context.compaction / background.task) ----

  const compactionStarted = () => ({
    type: "system", subtype: "context_compaction_started",
    compact_metadata: { trigger: "auto", pre_tokens: 1000 },
  })
  const compactionProgress = (progress: number) => ({
    type: "system", subtype: "context_compaction_progress",
    compact_metadata: { trigger: "auto", pre_tokens: 1000, stage: "summarizing", progress },
  })
  const compactBoundary = (extra: Record<string, unknown>) => ({
    type: "system", subtype: "compact_boundary",
    compact_metadata: { trigger: "auto", pre_tokens: 1000, ...extra },
  })
  const taskNotification = (fields: Record<string, unknown>) => ({
    type: "system", subtype: "task_notification",
    task_id: "bt1", status: "completed", session_id: "s1", ...fields,
  })

  test("compaction tri-state: started→progress→boundary success, orthogonal to turns", async () => {
    const events = await run([
      compactionStarted() as any,
      compactionProgress(45) as any,
      compactBoundary({ post_tokens: 200, summary: "compacted summary", outcome: "succeeded" }) as any,
    ])
    // Pure domain events: no run.start/turn/message side effects.
    expect(events).toHaveLength(3)
    expect(events.map((e) => `${e.kind}.${e.phase}:${e.detail.phase}`)).toEqual([
      "run.event:started", "run.event:progress", "run.event:completed",
    ])
    expect(events.every((e) => e.turnId === null)).toBe(true)
    // T2 追加①: preTokens 逐事件透传(web ContextWindowIndicator 真实消费,缺省不可恢复)
    expect(events.map((e) => e.detail.preTokens)).toEqual([1000, 1000, 1000])
    expect(events[1].detail.progress).toBe(45)
    expect(events[2].detail).toEqual({
      type: "context.compaction", phase: "completed",
      preTokens: 1000, postTokens: 200,
      result: "compacted summary", isError: false,
      trigger: "auto", outcome: "succeeded",
    })
  })

  test("compact_boundary failure → completed with isError:true and failure text", async () => {
    const events = await run([
      compactBoundary({ outcome: "failed", failure_reason: "provider_error" }) as any,
    ])
    expect(events).toHaveLength(1)
    expect(events[0].detail).toEqual({
      type: "context.compaction", phase: "completed",
      preTokens: 1000,
      result: "provider_error", isError: true,
      trigger: "auto", outcome: "failed",
    })
    // 失败路径无 post_tokens:字段不携带(不落默认 0)
    expect(events[0].detail.postTokens).toBeUndefined()
  })

  test("T3: compaction trigger 真值透传(manual/prompt_too_long)+缺省 'auto';outcome 仅 completed 携带", async () => {
    const events = await run([
      {
        type: "system", subtype: "context_compaction_started",
        compact_metadata: { trigger: "manual", pre_tokens: 1000 },
      },
      {
        type: "system", subtype: "context_compaction_progress",
        compact_metadata: { trigger: "prompt_too_long", pre_tokens: 1000, stage: "summarizing", progress: 45 },
      },
      // boundary 缺 trigger → 缺省 'auto';缺 outcome → 字段省略
      {
        type: "system", subtype: "compact_boundary",
        compact_metadata: { pre_tokens: 1000 },
      },
    ] as any[])
    expect(events.map((e) => e.detail.trigger)).toEqual(["manual", "prompt_too_long", "auto"])
    // outcome 条件携带:started/progress 恒省略;boundary 无 outcome 字段时也省略
    expect(events[0].detail.outcome).toBeUndefined()
    expect(events[1].detail.outcome).toBeUndefined()
    expect(events[2].detail.outcome).toBeUndefined()
  })

  test("in-run task_notification completed → background.task skeleton fields", async () => {
    const events = await run([
      taskNotification({
        status: "completed", message: "Task finished", summary: "did things",
        execution: { durationMs: 12 },
      }) as any,
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("run")
    expect(events[0].phase).toBe("event")
    expect(events[0].turnId).toBeNull()
    expect(events[0].detail).toEqual({
      type: "background.task", taskId: "bt1", status: "completed",
      message: "Task finished", summary: "did things", execution: { durationMs: 12 },
    })
    // Legacy status aliases map onto the four terminal states.
    const aliasEvents = await run([
      taskNotification({ task_id: "bt2", status: "killed" }) as any,
      taskNotification({ task_id: "bt3", status: "canceled" }) as any,
    ])
    expect(aliasEvents.map((e) => e.detail.status)).toEqual(["stopped", "cancelled"])
  })

  test("task_notification attention and unknown statuses produce no skeleton", async () => {
    const events = await run([
      taskNotification({ task_id: "at1", status: "attention" }) as any,
      taskNotification({ task_id: "at2", status: "running" }) as any,
    ])
    // T2 追加②收紧:断言全流为空(非仅 background.task 子集)——任何骨架外泄都算失败
    expect(events).toHaveLength(0)
  })

  test("subagent task_notification produces no skeleton (entry skip)", async () => {
    const events = await run([
      taskNotification({ subagent_run_id: "sub-1" }) as any,
    ])
    expect(events).toHaveLength(0)
  })

  test("thinking_delta folds into partial.thinking cumulatively (batch 5)", async () => {
    const thinkingDelta = (thinking: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
      parent_tool_use_id: null,
    })
    const events = await run([
      streamTextDelta("he") as any,
      thinkingDelta("hm") as any,
      thinkingDelta("... ") as any,
      thinkingDelta("hmm") as any,
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "he" }] } } as any,
    ])
    const updates = events.filter((e) => e.phase === "update")
    expect(updates).toHaveLength(4)
    // Native delta still rides the update untouched; thinking accumulates.
    expect(updates[1].detail.delta?.delta?.type).toBe("thinking_delta")
    expect(updates.map((e) => e.detail.partial.thinking)).toEqual(["", "hm", "hm... ", "hm... hmm"])
    expect(updates.every((e) => e.detail.partial.toolUses !== undefined)).toBe(true)
    expect(updates[3].detail.partial.text).toBe("he")
  })

  // ---- batch 5: user message pair / aborted run.end / domain classes ----

  test("user message: immediate start→end pair, turnId null, never opens the run", async () => {
    const events = await run([
      { type: "user", uuid: "u-1", message: { role: "user", content: "do the thing" } } as any,
      { type: "assistant", uuid: "a-1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } as any,
    ])
    expect(events.slice(0, 2).map((e) => `${e.kind}.${e.phase}`)).toEqual(["message.start", "message.end"])
    expect(events[1].detail).toEqual({ type: "user.message", content: "do the thing" })
    // User pair carries no turn and does not open the run by itself.
    expect(events.slice(0, 2).every((e) => e.turnId === null)).toBe(true)
    expect(events[2].kind === "run" && events[2].phase === "start").toBe(true)
    expect(events.filter((e) => e.kind === "turn")).toHaveLength(2) // turn.start + turn.end of the assistant turn
  })


  test("user message with structured content passes through as-is", async () => {
    const content = [{ type: "text", text: "part" }, { type: "image", source: { type: "base64" } }]
    const events = await run([
      { type: "user", uuid: "u-1", message: { role: "user", content } } as any,
    ])
    expect(events).toHaveLength(2)
    expect(events[1].detail.content).toEqual(content)
    // No assistant activity: no run/turn side effects.
    expect(events.some((e) => e.kind === "run" || e.kind === "turn")).toBe(false)
  })

  test("stream aborts with pending tool: run.end aborted after the dangling turn", async () => {
    const events = await run([
      streamTextDelta("wor") as any,
      assistantWithTool("u1") as any,
      // tool never runs, stream ends without a result message
    ])
    const kinds = events.map((e) => `${e.kind}.${e.phase}`)
    expect(kinds).toEqual([
      "run.start", "turn.start", "message.start", "message.update", "message.end",
      "tool.start", "run.end",
    ])
    const runEnd = events.at(-1)
    expect(runEnd.detail).toEqual({ type: "run.end", stopReason: "aborted", isError: false, numTurns: 1 })
  })

  test("stream aborts without tools: run.end aborted after turn.end", async () => {
    const events = await run([
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } } as any,
    ])
    expect(events.map((e) => `${e.kind}.${e.phase}`)).toEqual([
      "run.start", "turn.start", "message.start", "message.end", "turn.end", "run.end",
    ])
    expect(events.at(-1).detail.stopReason).toBe("aborted")
    expect(events.at(-1).detail.isError).toBe(false)
  })

  test("result present: run.end comes from the result path, aborted supplement stays silent", async () => {
    const events = await run([
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } } as any,
      { type: "result", subtype: "success", num_turns: 1 } as any,
    ])
    const runEnds = events.filter((e) => e.kind === "run" && e.phase === "end")
    expect(runEnds).toHaveLength(1)
    expect(runEnds[0].detail.stopReason).toBe("end_turn")
  })

  test("empty stream produces no events (run never opened)", async () => {
    const events = await run([])
    expect(events).toHaveLength(0)
  })

  test("plan_preview system message → run.event plan.preview skeleton", async () => {
    const events = await run([
      { type: "system", subtype: "plan_preview", contractId: "c-1", title: "The Plan",
        summary: "s", markdown: "# steps", planFilePath: "p.md", planVerified: true, stepCount: 3 } as any,
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("run")
    expect(events[0].phase).toBe("event")
    expect(events[0].turnId).toBeNull()
    expect(events[0].detail).toEqual({
      type: "plan.preview",
      content: { contractId: "c-1", title: "The Plan", summary: "s", markdown: "# steps",
        planFilePath: "p.md", planVerified: true, stepCount: 3 },
    })
  })

  test("todo_state_updated system message → run.event todo.state skeleton", async () => {
    const todos = [{ content: "a", activeForm: "doing a", status: "in_progress" }]
    const events = await run([
      { type: "system", subtype: "todo_state_updated", todos, currentActiveForm: "doing a" } as any,
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("run")
    expect(events[0].phase).toBe("event")
    expect(events[0].turnId).toBeNull()
    expect(events[0].detail).toEqual({
      type: "todo.state",
      state: { todos, currentActiveForm: "doing a" },
    })
  })

  test("task_progress system message → run.event task.progress skeleton", async () => {
    const events = await run([
      { type: "system", subtype: "task_progress", task_id: "bg-1", description: "work",
        usage: { total_tokens: 10, tool_uses: 2, duration_ms: 30 },
        last_tool_name: "Bash", summary: "halfway" } as any,
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("run")
    expect(events[0].phase).toBe("event")
    expect(events[0].turnId).toBeNull()
    expect(events[0].detail).toEqual({
      type: "task.progress",
      taskId: "bg-1",
      progress: { description: "work", usage: { total_tokens: 10, tool_uses: 2, duration_ms: 30 },
        last_tool_name: "Bash", summary: "halfway" },
    })
  })

  test("advisor_reviewed system message → run.event advisor.reviewed skeleton", async () => {
    const events = await run([
      { type: "system", subtype: "advisor_reviewed", severity: "concern", summary: "watch out",
        details: "line 3", modelRef: "gpt-x", durationMs: 120 } as any,
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("run")
    expect(events[0].phase).toBe("event")
    expect(events[0].turnId).toBeNull()
    expect(events[0].detail).toEqual({
      type: "advisor.reviewed",
      summary: "watch out",
      review: { severity: "concern", summary: "watch out", details: "line 3", modelRef: "gpt-x", durationMs: 120 },
    })
  })

  test("assistant.usage/costUSD 透传到 message.end detail(逐字段)", async () => {
    const events = await run([
      { type: "assistant", uuid: "u1", costUSD: 0.42, usage: {
        inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, totalTokens: 155,
      }, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } } as any,
    ])
    const msgEnd = events.find((e) => e.detail?.type === "message.end")
    expect(msgEnd).toBeDefined()
    expect(msgEnd.detail.message.usage).toEqual({
      inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 50, cacheCreationInputTokens: 0, totalTokens: 155,
    })
    expect(msgEnd.detail.message.costUSD).toBe(0.42)
  })

  test("usage 缺省时 message.end detail.message 不带 usage/costUSD 键(防 undefined 污染)", async () => {
    const events = await run([
      assistantWithTool("turn-usage-absent") as any,
      toolResult("t1") as any,
      { type: "result", subtype: "success", num_turns: 1 } as any,
    ])
    const msgEnd = events.find((e) => e.detail?.type === "message.end")
    expect(msgEnd).toBeDefined()
    expect("usage" in msgEnd.detail.message).toBe(false)
    expect("costUSD" in msgEnd.detail.message).toBe(false)
  })

  test("local_command_output with tool_use_id → run.event tool.output skeleton", async () => {
    const events = await run([
      { type: "system", subtype: "local_command_output", content: "build running...",
        tool_use_id: "toolu_1" } as any,
    ])
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("run")
    expect(events[0].phase).toBe("event")
    expect(events[0].turnId).toBeNull()
    expect(events[0].detail).toEqual({
      type: "tool.output",
      toolCallId: "toolu_1",
      chunk: "build running...",
    })
  })

  test("local_command_output without tool_use_id stays ignored (legacy form)", async () => {
    const events = await run([
      { type: "system", subtype: "local_command_output", content: "Command is still running." } as any,
      { type: "system", subtype: "local_command_output", content: "owned", tool_use_id: "" } as any,
    ])
    expect(events).toHaveLength(0)
  })
})
