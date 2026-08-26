import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { QueryEngine } from "./engine.js"
import { createToolSearchTool } from "./tools/tool-search.js"
import { FileEditTool } from "./tools/edit.js"
import { FileReadTool } from "./tools/read.js"
import { FileStateCache } from "./utils/fileCache.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"
import type { SDKMessage, ToolContext } from "./types.js"
import { normalizeProviderUsage } from "./utils/usage.js"
import { SkillRegistry } from "./skills/registry.js"

const structuredCompactionSummary = `## Goal
Continue the current task.

## Constraints & Preferences
- Preserve recent context.

## Progress
### Done
- [x] Summarized old history.

### In Progress
- [ ] Continue.

### Blocked
- (none)

## Key Decisions
- **Retention**: Keep the recent tail.

## Next Steps
1. Continue the task.

## Critical Context
- Recent messages remain verbatim.`

class StaticProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const
  private index = 0
  readonly requests: CreateMessageParams[] = []

  constructor(private readonly responses: CreateMessageResponse[]) {}

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.requests.push(params)
    const response = this.responses[this.index]
    this.index += 1
    if (!response) {
      throw new Error("unexpected provider call")
    }
    return response
  }
}

async function collectResult(engine: QueryEngine) {
  let result: unknown
  for await (const event of engine.submitMessage("run")) {
    if (event.type === "result") {
      result = event
    }
  }
  return result as { subtype: string; is_error: boolean; num_turns: number }
}

async function collectEvents(engine: QueryEngine, prompt = "run") {
  const events: unknown[] = []
  for await (const event of engine.submitMessage(prompt)) {
    events.push(event)
  }
  return events
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms))
}

describe("QueryEngine cancellation", () => {
  test("aborts from an active tool end the turn with an interrupted placeholder", async () => {
    const controller = new AbortController()
    const started = deferred<void>()
    const provider = new StaticProvider([{
      content: [{ type: "tool_use", id: "tool-1", name: "Wait", input: {} }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Wait",
        description: "wait",
        inputSchema: { type: "object", properties: {} },
        async call(_input, context) {
          started.resolve(undefined)
          return new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true })
          })
        },
      }],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      abortSignal: controller.signal,
    })

    const running = collectEvents(engine)
    await started.promise
    controller.abort()

    const events = (await running) as Array<{ type: string; result?: { is_error: boolean; content: string } }>
    expect(provider.requests).toHaveLength(1)
    // Soft abort: the run ends normally with a paired error tool_result.
    const toolResults = events.filter((event) => event.type === "tool_result")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].result?.is_error).toBe(true)
    expect(toolResults[0].result?.content).toContain("interrupted")
    expect(engine.getMessages().at(-1)?.role).toBe("user")
  })
})

describe("QueryEngine max_output_tokens recovery", () => {
  test("pairs a truncated tool_use with a placeholder result before continuing (#304)", async () => {
    const provider = new StaticProvider([
      {
        content: [
          { type: "text", text: "partial" },
          { type: "tool_use", id: "tool-1", name: "Echo", input: { payload: "truncated-by-limit" } },
        ],
        stopReason: "max_tokens",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "echo" }
        },
      }],
      systemPrompt: "test",
      maxTurns: 4,
      maxTokens: 256,
    })

    await collectEvents(engine)

    expect(provider.requests).toHaveLength(2)
    // The continuation request must carry the paired tool_result; otherwise
    // the provider rejects the dangling tool_use with an unrecoverable 400.
    const trailing = provider.requests[1]!.messages.at(-1) as {
      role: string
      content: Array<{ type: string; tool_use_id?: string; text?: string }>
    }
    expect(trailing.role).toBe("user")
    const placeholder = trailing.content.find((block) => block.type === "tool_result")
    expect(placeholder?.tool_use_id).toBe("tool-1")
    expect(
      trailing.content.some((block) => block.type === "text" && block.text?.includes("Please continue")),
    ).toBe(true)
  })
})

describe("QueryEngine turn limits", () => {
  test("executes a persisted approved tool exactly once before the resumed model request", async () => {
    let calls = 0
    let approvals = 0
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "resumed" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls += 1
          return { type: "tool_result", tool_use_id: "", content: "persisted content" }
        },
      }],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => {
        approvals += 1
        return { behavior: "allow" }
      },
      toolContinuations: [
        { toolCall: { id: "tool-resume-1", name: "Read", input: { file_path: "README.md" } } },
      ],
    })

    await collectEvents(engine, "ignored continuation prompt")

    expect(calls).toBe(1)
    expect(approvals).toBe(1)
    expect(provider.requests[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: [expect.objectContaining({ type: "tool_result", tool_use_id: "tool-resume-1" })],
      }),
    ]))
    expect(provider.requests[0]?.messages).not.toContainEqual({
      role: "user",
      content: "ignored continuation prompt",
    })
  })

  test("injects a persisted terminal tool result without executing the tool again", async () => {
    let calls = 0
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "continued from result" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Bash",
        description: "bash",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls += 1
          return { type: "tool_result", tool_use_id: "", content: "should not execute" }
        },
      }],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      toolContinuations: [
        {
          toolCall: { id: "tool-resume-2", name: "Bash", input: { command: "bun test" } },
          toolResult: { type: "tool_result", tool_use_id: "tool-resume-2", content: "2 pass" },
        },
      ],
    })

    await collectEvents(engine)

    expect(calls).toBe(0)
    expect(provider.requests[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: [expect.objectContaining({
          type: "tool_result",
          tool_use_id: "tool-resume-2",
          content: "2 pass",
        })],
      }),
    ]))
  })

  test("mixed continuations replay some tools and inject others", async () => {
    let calls = 0
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "mixed resumed" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls += 1
          return { type: "tool_result", tool_use_id: "", content: "replayed" }
        },
      }],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      toolContinuations: [
        { toolCall: { id: "t-inject", name: "Read", input: { file_path: "x" } },
          toolResult: { type: "tool_result", tool_use_id: "t-inject", content: "injected" } },
        { toolCall: { id: "t-replay", name: "Read", input: { file_path: "y" } } },
      ],
    })

    await collectEvents(engine)

    expect(calls).toBe(1) // only t-replay is replayed
    const request = provider.requests[0]?.messages as any[]
    const toolResults = request.flatMap((m) => Array.isArray(m.content) ? m.content : [])
      .filter((c: any) => c.type === "tool_result")
    const ids = toolResults.map((c: any) => c.tool_use_id).sort()
    expect(ids).toEqual(["t-inject", "t-replay"])
    // Array-pairing core semantics: every continuation result must land in the
    // SAME user message (one tool-boundary repair turn, not one per tool).
    const carrierMessages = request.filter(
      (m) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"),
    )
    expect(carrierMessages).toHaveLength(1)
    expect(carrierMessages[0]?.role).toBe("user")
    expect((carrierMessages[0]?.content as any[]).map((c) => c.tool_use_id).sort())
      .toEqual(["t-inject", "t-replay"])
  })

  test("forwards exactly terminal task notifications emitted after a tool call returns", async () => {
    let emitAfterReturn: NonNullable<ToolContext["emitEvent"]> | undefined
    const asyncEvents: SDKMessage[] = []
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        {
          content: [{ type: "tool_use", id: "background-1", name: "Background", input: {} }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "text", text: "background command accepted" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [{
        name: "Background",
        description: "starts background work",
        inputSchema: { type: "object", properties: {} },
        async call(_input, context) {
          emitAfterReturn = context.emitEvent
          context.emitEvent?.({
            type: "system",
            subtype: "task_started",
            task_id: "task_1",
            description: "background work",
            session_id: "session"
          })
          return { type: "tool_result" as const, tool_use_id: "", content: "started" }
        }
      }],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      onAsyncEvent: (event) => asyncEvents.push(event)
    })

    const events = await collectEvents(engine)
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "task_started",
      task_id: "task_1"
    }))

    emitAfterReturn?.({
      type: "system",
      subtype: "local_command_output",
      content: "late progress",
      session_id: "session"
    })
    emitAfterReturn?.({
      type: "system",
      subtype: "task_notification",
      task_id: "task_1",
      status: "completed",
      session_id: "session"
    })

    expect(asyncEvents).toEqual([
      expect.objectContaining({
        type: "system",
        subtype: "task_notification",
        task_id: "task_1",
        status: "completed"
      })
    ])
  })

  test("delivers live events immediately while a tool runs and closes the channel after it returns", async () => {
    const liveEvents: SDKMessage[] = []
    let liveEmitDuringCall: NonNullable<ToolContext["emitLiveEvent"]> | undefined
    let resolveTool: (() => void) | undefined
    const toolGate = new Promise<void>((resolve) => { resolveTool = resolve })
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "long-1", name: "LongCmd", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ])
    let sawFirstLiveBeforeToolReturn = false
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "LongCmd",
        description: "long running command",
        inputSchema: { type: "object", properties: {} },
        async call(_input, context) {
          liveEmitDuringCall = context.emitLiveEvent
          context.emitLiveEvent?.({
            type: "system",
            subtype: "task_progress",
            task_id: "task_live",
            description: "tick 1",
            session_id: "session"
          })
          sawFirstLiveBeforeToolReturn = liveEvents.length > 0
          await toolGate
          return { type: "tool_result" as const, tool_use_id: "", content: "finished" }
        }
      }],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      onLiveEvent: (event) => liveEvents.push(event)
    })

    const collected = collectEvents(engine)
    // Give the tool call a chance to start and emit before resolving the gate.
    await new Promise((resolve) => setTimeout(resolve, 20))
    resolveTool?.()
    const events = await collected

    expect(sawFirstLiveBeforeToolReturn).toBe(true)
    expect(liveEvents).toHaveLength(1)
    expect(liveEvents[0]).toMatchObject({ subtype: "task_progress", task_id: "task_live" })
    // Live events bypass the deferred stream entirely.
    expect(events.filter((event) => event.type === "system" && (event as { subtype?: string }).subtype === "task_progress")).toHaveLength(0)

    // Channel is closed once the tool call returned.
    liveEmitDuringCall?.({
      type: "system",
      subtype: "task_progress",
      task_id: "task_live",
      description: "late tick",
      session_id: "session"
    })
    expect(liveEvents).toHaveLength(1)
  })

  test("treats a natural completion on the final allowed turn as success", async () => {
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([{
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }]),
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false,
      num_turns: 1
    })
  })

  test("completion guard feeds back into the loop before natural completion", async () => {
    let guardCalls = 0
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        {
          content: [{ type: "text", text: "initial answer" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "text", text: "completed after guard" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      completionGuard: async () => {
        guardCalls += 1
        return guardCalls === 1 ? "A task is still awaiting review. Resolve it before finishing." : undefined
      }
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false,
      num_turns: 2
    })
    expect(guardCalls).toBe(2)
    expect(engine.getMessages()).toContainEqual(expect.objectContaining({
      role: "user",
      content: "A task is still awaiting review. Resolve it before finishing."
    }))
  })

  test("completion guard can stop with an error instead of reporting success", async () => {
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([{
        content: [{ type: "text", text: "verification failed" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }]),
      tools: [],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      completionGuard: async () => ({
        type: "stop",
        errorCode: "verification_failed_after_repair",
        message: "verification failed after one repair"
      })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "error_completion_guard",
      is_error: true,
      errors: ["verification failed after one repair"]
    })
  })

  test("blocks a third mutation when normalized input and result are unchanged", async () => {
    let calls = 0
    const provider = new StaticProvider([
      {
        content: [{
          type: "tool_use",
          id: "navigate-1",
          name: "Navigate",
          input: { url: "https://example.com/search?q=lume", options: { wait: true } }
        }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{
          type: "tool_use",
          id: "navigate-2",
          name: "Navigate",
          input: { options: { wait: true }, url: "https://example.com/search?q=lume" }
        }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{
          type: "tool_use",
          id: "navigate-3",
          name: "Navigate",
          input: { url: "https://example.com/search?q=lume", options: { wait: true } }
        }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "Search page is already open." }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Navigate",
        description: "navigate",
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => false,
        async call() {
          calls++
          return {
            type: "tool_result",
            tool_use_id: "",
            content: JSON.stringify({ operation_id: `navigate-${calls}`, tab_id: `tab-${calls}` }),
            _meta: { repeatGuard: { state: { url: "https://example.com/search?q=lume", title: "Search" } } }
          }
        }
      }],
      systemPrompt: "test",
      maxTurns: 8,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false,
      num_turns: 4
    })
    expect(calls).toBe(2)
    expect(engine.getMessages()).toContainEqual(expect.objectContaining({
      role: "user",
      content: [expect.objectContaining({
        tool_use_id: "navigate-3",
        is_error: true,
        content: expect.stringContaining("Do not retry the unchanged call"),
        _meta: expect.objectContaining({
          error: { code: "repeated_tool_call", retryable: false }
        })
      })]
    }))
  })

  test("stops early when the model ignores repeated-call feedback", async () => {
    let calls = 0
    const repeatedCall = (id: string): CreateMessageResponse => ({
      content: [{ type: "tool_use", id, name: "Navigate", input: { url: "https://example.com" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        repeatedCall("navigate-1"),
        repeatedCall("navigate-2"),
        repeatedCall("navigate-3"),
        repeatedCall("navigate-4")
      ]),
      tools: [{
        name: "Navigate",
        description: "navigate",
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => false,
        async call() {
          calls++
          return { type: "tool_result", tool_use_id: "", content: "same page state" }
        }
      }],
      systemPrompt: "test",
      maxTurns: 80,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "error_completion_guard",
      is_error: true,
      errorCode: "repeated_tool_call",
      num_turns: 4
    })
    expect(calls).toBe(2)
  })

  test("alternating between two blocked signatures still trips the breaker (#358)", async () => {
    const calls = { A: 0, B: 0 }
    const call = (id: string, name: "Alpha" | "Bravo"): CreateMessageResponse => ({
      content: [{ type: "tool_use", id, name, input: {} }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        call("a-1", "Alpha"),
        call("b-1", "Bravo"),
        call("a-2", "Alpha"),
        call("b-2", "Bravo"),
        call("a-3", "Alpha"), // blocked: first breaker hit
        call("b-3", "Bravo") // blocked: second breaker hit ends the run
      ]),
      tools: (["Alpha", "Bravo"] as const).map((name) => ({
        name,
        description: `${name} tool`,
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => false,
        async call() {
          calls[name === "Alpha" ? "A" : "B"] += 1
          return { type: "tool_result", tool_use_id: "", content: `unchanged ${name}` }
        }
      })),
      systemPrompt: "test",
      maxTurns: 80,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    // Old behavior alternated the counter reset between signatures and never
    // stopped; now the second blocked attempt (any signature) ends the run.
    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "error_completion_guard",
      is_error: true
    })
    expect(calls.A).toBe(2)
    expect(calls.B).toBe(2)
  })

  test("allows repeated mutation input while the result state keeps changing", async () => {
    let calls = 0
    const repeatedCall = (id: string): CreateMessageResponse => ({
      content: [{ type: "tool_use", id, name: "Advance", input: { target: "next" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        repeatedCall("advance-1"),
        repeatedCall("advance-2"),
        repeatedCall("advance-3"),
        {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [{
        name: "Advance",
        description: "advance",
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => false,
        async call() {
          calls++
          return { type: "tool_result", tool_use_id: "", content: `state-${calls}` }
        }
      }],
      systemPrompt: "test",
      maxTurns: 8,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false,
      num_turns: 4
    })
    expect(calls).toBe(3)
  })

  test("keeps the blocked counter across alternating stalled signatures", async () => {
    const calls = { a: 0, b: 0 }
    const stalledCall = (id: string, variant: "a" | "b"): CreateMessageResponse => ({
      content: [{
        type: "tool_use",
        id,
        name: "Edit",
        input: variant === "a" ? { file: "a.txt" } : { file: "b.txt" }
      }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        stalledCall("edit-a1", "a"),
        stalledCall("edit-b1", "b"),
        stalledCall("edit-a2", "a"),
        stalledCall("edit-b2", "b"),
        // Both signatures are now at count=2; alternating re-attempts must hit
        // the global consecutive counter instead of resetting it per signature.
        stalledCall("edit-a3", "a"),
        stalledCall("edit-b3", "b")
      ]),
      tools: [{
        name: "Edit",
        description: "edit",
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => false,
        async call(input: any) {
          if (input.file === "a.txt") calls.a++
          else calls.b++
          return { type: "tool_result", tool_use_id: "", content: "unchanged state" }
        }
      }],
      systemPrompt: "test",
      maxTurns: 80,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    // Each signature only reaches count=2 on its own turn, so per-signature
    // bookkeeping alone would never stop; the global consecutive counter must.
    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "error_completion_guard",
      is_error: true,
      errorCode: "repeated_tool_call"
    })
    // Each signature executes exactly twice to build up equivalence; every
    // re-attempt after that is refused without executing.
    expect(calls.a).toBe(2)
    expect(calls.b).toBe(2)
  })

  test("skips remaining same-batch tools after the repeat guard stops", async () => {
    const calls = { navigate: 0, write: 0 }
    const navigateCall = (id: string): CreateMessageResponse => ({
      content: [{ type: "tool_use", id, name: "Navigate", input: { url: "https://example.com" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        navigateCall("nav-1"),
        navigateCall("nav-2"),
        navigateCall("nav-3"),
        {
          content: [
            { type: "tool_use", id: "nav-4", name: "Navigate", input: { url: "https://example.com" } },
            { type: "tool_use", id: "write-4", name: "Write", input: { path: "x.txt", content: "hi" } }
          ],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "text", text: "stopped" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [
        {
          name: "Navigate",
          description: "navigate",
          inputSchema: { type: "object", properties: {} },
          isReadOnly: () => false,
          async call() {
            calls.navigate++
            return { type: "tool_result", tool_use_id: "", content: "same page" }
          }
        },
        {
          name: "Write",
          description: "write",
          inputSchema: { type: "object", properties: {} },
          isReadOnly: () => false,
          async call() {
            calls.write++
            return { type: "tool_result", tool_use_id: "", content: "written" }
          }
        }
      ],
      systemPrompt: "test",
      maxTurns: 80,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    // The 4th Navigate hits the hard stop inside the same batch as Write;
    // Write must not execute (no side effects after the stop decision) and
    // still needs a paired tool_result.
    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "error_completion_guard",
      is_error: true
    })
    expect(calls.navigate).toBe(2)
    expect(calls.write).toBe(0)
    expect(engine.getMessages()).toContainEqual(expect.objectContaining({
      role: "user",
      content: expect.arrayContaining([expect.objectContaining({
        tool_use_id: "write-4",
        is_error: true,
        content: expect.stringContaining("Skipped")
      })])
    }))
  })

  test("blocks repeated equivalent failures of read-only tools without stopping the run", async () => {
    let calls = 0
    const grepCall = (id: string): CreateMessageResponse => ({
      content: [{ type: "tool_use", id, name: "Grep", input: { pattern: "foo" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        grepCall("grep-1"),
        grepCall("grep-2"),
        grepCall("grep-3"),
        grepCall("grep-4"),
        {
          content: [{ type: "text", text: "giving up" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [{
        name: "Grep",
        description: "grep",
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => true,
        async call() {
          calls++
          return { type: "tool_result", tool_use_id: "", content: "connect ETIMEDOUT", is_error: true }
        }
      }],
      systemPrompt: "test",
      maxTurns: 80,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    // Equivalent failures are refused from the third identical call on, but a
    // transient failure never escalates to terminating the whole run.
    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false
    })
    expect(calls).toBe(2)
    expect(engine.getMessages()).toContainEqual(expect.objectContaining({
      role: "user",
      content: [expect.objectContaining({
        tool_use_id: "grep-3",
        is_error: true,
        content: expect.stringContaining("Do not retry the unchanged call")
      })]
    }))
  })

  test("recognizes equivalent read-only results via repeatGuard state in concurrent batches", async () => {
    let calls = 0
    const snapshotCall = (id: string): CreateMessageResponse => ({
      content: [{ type: "tool_use", id, name: "Snapshot", input: { tab: "main" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        snapshotCall("snap-1"),
        snapshotCall("snap-2"),
        snapshotCall("snap-3"),
        {
          content: [{ type: "text", text: "page unchanged" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [{
        name: "Snapshot",
        description: "snapshot",
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => true,
        async call() {
          calls++
          return {
            type: "tool_result",
            tool_use_id: "",
            content: JSON.stringify({ operation_id: `op-${calls}`, tree: "same-dom" }),
            _meta: { repeatGuard: { state: { ok: true, tool: "snapshot", tree: "same-dom" } } }
          }
        }
      }],
      systemPrompt: "test",
      maxTurns: 80,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    // Volatile operation ids differ per call, but the exposed stable state is
    // equal — the concurrent read-only path must honor it and refuse #3.
    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false,
      num_turns: 4
    })
    expect(calls).toBe(2)
  })

  test("does not count permission denials toward equivalence", async () => {
    let executions = 0
    let permissionCalls = 0
    const bashCall = (id: string): CreateMessageResponse => ({
      content: [{ type: "tool_use", id, name: "Bash", input: { command: "npm install" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        bashCall("bash-1"),
        bashCall("bash-2"),
        bashCall("bash-3"),
        {
          content: [{ type: "text", text: "installed" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [{
        name: "Bash",
        description: "bash",
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => false,
        async call() {
          executions++
          return { type: "tool_result", tool_use_id: "", content: "done" }
        }
      }],
      systemPrompt: "test",
      maxTurns: 80,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => {
        permissionCalls++
        return permissionCalls <= 2
          ? { behavior: "deny", message: "Not approved yet" }
          : { behavior: "allow" }
      }
    })

    // The third identical call must reach canUseTool again (user changed their
    // mind) instead of being refused by repeat-guard accounting.
    const result = await collectResult(engine)
    expect(result).toMatchObject({
      subtype: "success",
      is_error: false
    })
    expect(permissionCalls).toBe(3)
    expect(executions).toBe(1)
    expect(result.permission_denials).toHaveLength(2)
  })

  test("fresh successful progress resets the consecutive blocked counter", async () => {
    const calls = { editA: 0, editB: 0, status: 0 }
    const editACall = (id: string): CreateMessageResponse => ({
      content: [{ type: "tool_use", id, name: "Edit", input: { file: "a.txt" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 }
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        editACall("a1"),
        editACall("a2"),
        editACall("a3-blocked"),
        {
          content: [{ type: "tool_use", id: "status-1", name: "Status", input: {} }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "tool_use", id: "b1", name: "Edit", input: { file: "b.txt" } }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "tool_use", id: "b2", name: "Edit", input: { file: "b.txt" } }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "tool_use", id: "b3-blocked", name: "Edit", input: { file: "b.txt" } }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "text", text: "moved on" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [
        {
          name: "Edit",
          description: "edit",
          inputSchema: { type: "object", properties: {} },
          isReadOnly: () => false,
          async call(input: any) {
            if (input.file === "a.txt") {
              calls.editA++
              return { type: "tool_result", tool_use_id: "", content: "still failing", is_error: true }
            }
            calls.editB++
            return { type: "tool_result", tool_use_id: "", content: "still failing b", is_error: true }
          }
        },
        {
          name: "Status",
          description: "status",
          inputSchema: { type: "object", properties: {} },
          isReadOnly: () => false,
          async call() {
            calls.status++
            return { type: "tool_result", tool_use_id: "", content: "clean tree" }
          }
        }
      ],
      systemPrompt: "test",
      maxTurns: 80,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    // The Status success between the two stalls proves real progress, so the
    // second stall starts counting from one instead of immediately stopping.
    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false
    })
    expect(calls.editA).toBe(2)
    expect(calls.status).toBe(1)
    expect(calls.editB).toBe(2)
  })

  test("preserves provider tool-call result order across concurrent and serial tools", async () => {
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        {
          content: [
            { type: "tool_use", id: "serial-1", name: "Serial", input: {} },
            { type: "tool_use", id: "concurrent-1", name: "Concurrent", input: {} }
          ],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [
        {
          name: "Serial",
          description: "serial tool",
          inputSchema: { type: "object", properties: {} },
          async call() {
            return { type: "tool_result" as const, tool_use_id: "", content: "serial result" }
          }
        },
        {
          name: "Concurrent",
          description: "concurrent tool",
          inputSchema: { type: "object", properties: {} },
          isConcurrencySafe: () => true,
          async call() {
            return { type: "tool_result" as const, tool_use_id: "", content: "concurrent result" }
          }
        }
      ],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await collectResult(engine)

    const toolResultMessage = engine.getMessages().find((message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.every((block: any) => block.type === "tool_result")
    )
    expect(toolResultMessage?.content).toEqual([
      expect.objectContaining({ tool_use_id: "serial-1", content: "serial result" }),
      expect.objectContaining({ tool_use_id: "concurrent-1", content: "concurrent result" })
    ])
  })

  // #210: NaN made every concurrent batch empty (all tools "did not return a
  // result"); '0' made the batch loop spin forever.
  for (const badValue of ["0", "garbage"]) {
    test(`invalid AGENT_SDK_MAX_TOOL_CONCURRENCY=${badValue} degrades to serial instead of failing or hanging`, async () => {
      const previous = process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY
      process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY = badValue
      try {
        const engine = new QueryEngine({
          cwd: process.cwd(),
          model: "test-model",
          provider: new StaticProvider([
            {
              content: [{ type: "tool_use", id: "concurrent-1", name: "Concurrent", input: {} }],
              stopReason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 }
            },
            {
              content: [{ type: "text", text: "done" }],
              stopReason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 }
            }
          ]),
          tools: [
            {
              name: "Concurrent",
              description: "concurrent tool",
              inputSchema: { type: "object", properties: {} },
              isConcurrencySafe: () => true,
              async call() {
                return { type: "tool_result" as const, tool_use_id: "", content: "concurrent result" }
              }
            }
          ],
          systemPrompt: "test",
          maxTurns: 2,
          maxTokens: 256,
          includePartialMessages: false,
          canUseTool: async () => ({ behavior: "allow" })
        })

        await collectResult(engine)

        const toolResultMessage = engine.getMessages().find((message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.every((block: any) => block.type === "tool_result")
        )
        expect(toolResultMessage?.content).toEqual([
          expect.objectContaining({ tool_use_id: "concurrent-1", content: "concurrent result" })
        ])
      } finally {
        if (previous === undefined) delete process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY
        else process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY = previous
      }
    })
  }
})

describe("QueryEngine context controller", () => {
  test("emits compaction started before awaiting compaction completion", async () => {
    const releaseCompaction = deferred<void>();
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => true,
        async compactConversation() {
          await releaseCompaction.promise;
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\ndelayed summary" },
              { role: "assistant", content: "I will continue." }
            ],
            summary: "delayed summary",
            metadata: {
              policy: "kernel-v1",
              source: "agent-runtime-kernel"
            }
          };
        }
      }
    });

    const iterator = engine.submitMessage("run");
    // session_state_changed was retired (#413): init is now the first event.
    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "init"
    });

    const started = await Promise.race([iterator.next(), wait(30)]);
    if (started === null) {
      releaseCompaction.resolve();
    }

    expect(started).not.toBeNull();
    expect(started && "value" in started ? started.value : undefined).toMatchObject({
      type: "system",
      subtype: "context_compaction_started",
      compact_metadata: expect.objectContaining({
        trigger: "auto"
      })
    });

    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "context_compaction_progress",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        stage: "summarizing",
        progress: expect.any(Number)
      })
    });

    releaseCompaction.resolve();
    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "context_compaction_progress",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        stage: "rewriting_context",
        progress: expect.any(Number)
      })
    });

    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        summary: "delayed summary"
      })
    });
  });

  test("lets a host controller own auto-compaction decisions and metadata", async () => {
    const observedMessages: CreateMessageParams["messages"][] = [];
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedMessages.push(params.messages);
      return originalCreateMessage(params);
    };
    const boundaries: unknown[] = [];

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: ({ messages }) => messages.length > 0,
        getCompactionMetadata: () => ({
          policy: "kernel-v1",
          source: "agent-runtime-kernel",
          sourceMessageIds: ["user-1"]
        }),
        async compactConversation() {
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nkernel summary" },
              { role: "assistant", content: "I will continue." }
            ],
            summary: "kernel summary",
            metadata: {
              policy: "kernel-v1",
              source: "agent-runtime-kernel",
              sourceMessageIds: ["user-1"]
            }
          };
        },
        microCompactMessages: ({ messages }) => messages,
        onCompactionBoundary: (boundary) => {
          boundaries.push(boundary);
        }
      }
    });
    engine.messages.push({ role: "user", content: "old context" });

    const events = await collectEvents(engine);

    expect(observedMessages[0]?.[0]?.content).toContain("kernel summary");
    expect(boundaries).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_started",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        policy: "kernel-v1",
        source: "agent-runtime-kernel"
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        summary: "kernel summary",
        policy: "kernel-v1",
        source: "agent-runtime-kernel",
        source_message_ids: ["user-1"]
      })
    }));
  });

  test("preserves only the latest runtime context across compaction", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "stable system",
      runtimeContext: "latest runtime",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => true,
        async compactConversation() {
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nsummary" },
              { role: "runtime", content: "stale summarized runtime" }
            ],
            summary: "summary",
            metadata: { policy: "kernel-v1", source: "agent-runtime-kernel" }
          };
        }
      }
    });
    engine.messages.push({ role: "runtime", content: "old runtime" });

    await collectEvents(engine);

    const runtimeMessages = provider.requests[0]?.messages.filter((message) => message.role === "runtime");
    expect(runtimeMessages).toEqual([{ role: "runtime", content: "latest runtime" }]);
  });

  test("replaces the previous runtime context on the next turn without compaction", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "text", text: "first" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "second" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "stable system",
      runtimeContext: "turn one context",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);
    engine.config.runtimeContext = "turn two context";
    await collectResult(engine);

    const runtimeMessages = provider.requests[1]?.messages.filter((message) => message.role === "runtime");
    expect(runtimeMessages).toEqual([{ role: "runtime", content: "turn two context" }]);
  });

  test("runs slash compact as a manual kernel compaction without calling the provider", async () => {
    const provider = new StaticProvider([]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => false,
        async compactConversation({ trigger }) {
          expect(trigger).toBe("manual");
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nmanual summary" },
              { role: "assistant", content: "I will continue." }
            ],
            summary: "manual summary",
            metadata: {
              policy: "kernel-v1",
              source: "agent-runtime-kernel"
            }
          };
        }
      }
    });
    engine.messages.push({ role: "user", content: "old context" });

    const events = await collectEvents(engine, "/compact");

    expect(engine.getMessages()[0]?.content).toContain("manual summary");
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        trigger: "manual",
        summary: "manual summary"
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "result",
      subtype: "success",
      num_turns: 0,
      is_error: false
    }));
  });

  test("emits prompt-too-long compaction boundary before retrying provider", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      async createMessage() {
        calls += 1;
        if (calls === 1) {
          const error = new Error("prompt is too long") as Error & { status: number };
          error.status = 400;
          throw error;
        }
        return {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      }
    };
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => false,
        getCompactionMetadata: () => ({
          policy: "kernel-v1",
          source: "agent-runtime-kernel"
        }),
        async compactConversation({ trigger }) {
          expect(trigger).toBe("prompt_too_long");
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nretry summary" },
              { role: "assistant", content: "I will continue." }
            ],
            summary: "retry summary",
            metadata: {
              policy: "kernel-v1",
              source: "agent-runtime-kernel"
            }
          };
        }
      }
    });

    const events = await collectEvents(engine);

    expect(calls).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_started",
      compact_metadata: expect.objectContaining({
        trigger: "prompt_too_long",
        policy: "kernel-v1",
        source: "agent-runtime-kernel"
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        trigger: "prompt_too_long",
        summary: "retry summary"
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "result",
      subtype: "success",
      is_error: false
    }));
  });

  test("keeps the original history when compaction is rejected", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => true,
        async compactConversation({ messages, state }) {
          return {
            compacted: false,
            compactedMessages: messages,
            summary: "",
            failureReason: "max_tokens",
            state: { ...state, consecutiveFailures: state.consecutiveFailures + 1 }
          };
        }
      }
    });
    engine.messages.push({ role: "user", content: "original history" });

    const events = await collectEvents(engine);

    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("original history");
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        outcome: "failed",
        failure_reason: "max_tokens"
      })
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_progress",
      compact_metadata: expect.objectContaining({ stage: "rewriting_context" })
    }));
  });

  test("checks automatic compaction only once before a tool loop", async () => {
    let checks = 0;
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "read-1", name: "Read", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 1 }
      }
    ]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => true,
        async call() {
          return { type: "tool_result", tool_use_id: "read-1", content: "result" };
        }
      }],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => {
          checks += 1;
          return false;
        }
      }
    });

    await collectEvents(engine);

    expect(checks).toBe(1);
    expect(provider.requests).toHaveLength(2);
  });

  test("does not retry a prompt-too-long request when compaction is rejected", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      async createMessage() {
        calls += 1;
        const error = new Error("prompt is too long") as Error & { status: number };
        error.status = 400;
        throw error;
      }
    };
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => false,
        async compactConversation({ messages }) {
          return {
            compacted: false,
            compactedMessages: messages,
            summary: "",
            failureReason: "max_tokens"
          };
        }
      }
    });

    const events = await collectEvents(engine, "current task");

    expect(calls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "result",
      subtype: "error_during_execution",
      is_error: true
    }));
  });

  test("compacts again when the tool loop outgrows the window a second time (#353)", async () => {
    let calls = 0;
    let compactions = 0;
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      async createMessage() {
        calls += 1;
        if (calls === 1 || calls === 2) {
          const error = new Error("prompt is too long") as Error & { status: number };
          error.status = 400;
          throw error;
        }
        return {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      }
    };
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => false,
        async compactConversation({ messages }) {
          compactions += 1;
          return {
            compactedMessages: [
              { role: "user", content: `[Previous conversation summary]\n\nsummary ${compactions}` },
              ...messages.slice(-1)
            ],
            summary: `summary ${compactions}`
          };
        }
      }
    });

    const events = await collectEvents(engine, "loop grew again");

    // A second too-long after one successful compaction must trigger another
    // compaction instead of terminating the run.
    expect(compactions).toBe(2);
    expect(calls).toBe(3);
    expect(events).toContainEqual(expect.objectContaining({
      type: "result",
      subtype: "success",
      is_error: false
    }));
  });
});

describe("QueryEngine auto compaction usage", () => {
  test("uses provider context usage threshold and records compaction usage outside the context anchor", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "text", text: structuredCompactionSummary }],
        stopReason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 8 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 10 }
      }
    ]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 16_384,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      sessionId: "thread-compact"
    });
    engine.messages.push({ role: "user", content: "o".repeat(80_000) });
    engine.messages.push({
      role: "assistant",
      content: "",
      usage: {
        inputTokens: 190_600,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 190_620
      },
      usageIdentity: {
        threadId: "thread-compact",
        callerKind: "conversation",
        turn: 1
      }
    } as any);
    engine.messages.push({ role: "user", content: "r".repeat(84_000) });

    const events = await collectEvents(engine);
    const result = events.find((event) => (event as { type?: string }).type === "result") as any;

    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_started",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        pre_tokens: expect.any(Number),
        context_window: 200_000
      })
    }));
    expect(result.billingUsage.records.map((record: any) => record.usageIdentity.callerKind)).toEqual([
      "compaction",
      "conversation"
    ]);
    expect(result.billingUsage.records[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 8
    });
    expect(result.contextUsage).toMatchObject({
      source: "provider",
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60
    });
  }, 30_000);

  test("does not auto compact when only non-conversation usage is above threshold", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 16_384,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      sessionId: "thread-non-conversation"
    });
    engine.messages.push({
      role: "assistant",
      content: "",
      usage: normalizeProviderUsage({ input_tokens: 300_000, output_tokens: 1_000 }),
      usageIdentity: {
        threadId: "thread-non-conversation",
        callerKind: "compaction"
      }
    } as any);

    const events = await collectEvents(engine);

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_started"
    }));
  });
});

describe("QueryEngine skill allowed tools", () => {
  test("activates a matching deferred tool after loading a skill", async () => {
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "browser:browser" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, activatedTools: ["mcp__node_repl__js"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const browserTool = {
      name: "mcp__node_repl__js",
      description: "browser runtime",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "browser" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool],
      deferredTools: [browserTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(observedTools[0]).toEqual(["Read", "Skill"]);
    expect(observedTools[1]).toEqual(["Read", "Skill", "mcp__node_repl__js"]);
  });

  test("skill activation reports promoted names through onToolsActivated", async () => {
    const activations: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "browser:browser" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, activatedTools: ["mcp__node_repl__js"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const browserTool = {
      name: "mcp__node_repl__js",
      description: "browser runtime",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "browser" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool],
      deferredTools: [browserTool],
      onToolsActivated: (names) => activations.push([...names]),
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(activations).toEqual([["mcp__node_repl__js"]]);
  });

  test("skill narrowing without activation does not call onToolsActivated", async () => {
    const activations: string[][] = [];
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["Read"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const writeTool = {
      name: "Write",
      description: "write",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "write" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool, writeTool],
      onToolsActivated: (names) => activations.push([...names]),
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(activations).toEqual([]);
    expect(observedTools[0]).toEqual(["Read", "Skill", "Write"]);
    expect(observedTools[1]).toEqual(["Read", "Skill"]);
  });

  test("preserves runtime-required tools when Skill.allowedTools narrows visibility", async () => {
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["Read"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const taskReportTool = {
      name: "TaskReport",
      description: "report",
      inputSchema: { type: "object" as const, properties: {} },
      runtimeMetadata: { requiredDuringSkillScope: true },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "reported" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool, taskReportTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(observedTools[0]).toEqual(["Read", "Skill", "TaskReport"]);
    expect(observedTools[1]).toEqual(["Read", "Skill", "TaskReport"]);
  });

  test("applies Skill.allowedTools to subsequent provider turns in the same run", async () => {
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["Read"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const writeTool = {
      name: "Write",
      description: "write",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "write" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool, writeTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(observedTools[0]).toEqual(["Read", "Skill", "Write"]);
    expect(observedTools[1]).toEqual(["Read", "Skill"]);
  });

  test("applies Alice-style Skill.allowedTools aliases to SDK tool names", async () => {
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["read_file", "bash"] })
        };
      }
    };
    const bashTool = {
      name: "Bash",
      description: "bash",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "bash" };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const writeTool = {
      name: "Write",
      description: "write",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "write" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, bashTool, readTool, writeTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(observedTools[0]).toEqual(["Bash", "Read", "Skill", "Write"]);
    expect(observedTools[1]).toEqual(["Bash", "Read", "Skill"]);
  });

  test("does not execute sibling tool calls in the same turn as a Skill activation", async () => {
    const observedTools: string[][] = [];
    const calledTools: string[] = [];
    const provider = new StaticProvider([
      {
        content: [
          { type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "secret.txt" } },
          { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "secret.txt", content: "leak" } }
        ],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        calledTools.push("Skill");
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["Bash"] })
        };
      }
    };
    const bashTool = {
      name: "Bash",
      description: "bash",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        calledTools.push("Bash");
        return { type: "tool_result" as const, tool_use_id: "", content: "bash" };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      isReadOnly: () => true,
      async call() {
        calledTools.push("Read");
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const writeTool = {
      name: "Write",
      description: "write",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        calledTools.push("Write");
        return { type: "tool_result" as const, tool_use_id: "", content: "write" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, bashTool, readTool, writeTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(calledTools).toEqual(["Skill"]);
    expect(observedTools[0]).toEqual(["Bash", "Read", "Skill", "Write"]);
    expect(observedTools[1]).toEqual(["Bash", "Skill"]);
  });
});

describe("QueryEngine deferred tool promotion", () => {
  test("activateTools promotes deferred tools into the native tools array", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "probe-1", name: "ProbeTool", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    let promoted: string[] = [];
    const probeTool = {
      name: "ProbeTool",
      description: "probe",
      inputSchema: { type: "object" as const, properties: {} },
      async call(_input: unknown, context: ToolContext) {
        promoted = context.activateTools?.(["GuanlanSearch", "GuanlanSearch", "NoSuchTool"]) ?? [];
        return { type: "tool_result" as const, tool_use_id: "", content: "probe done" };
      }
    };
    const deferredTool = {
      name: "GuanlanSearch",
      description: "search guanlan",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "guanlan" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [probeTool],
      deferredTools: [deferredTool],
      systemPrompt: "test",
      maxTurns: 5,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    // Unknown names are ignored and already-promoted names are not duplicated.
    expect(promoted).toEqual(["GuanlanSearch"]);
    const lastRequest = provider.requests[provider.requests.length - 1];
    const names = (lastRequest.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("GuanlanSearch");
    expect(names.filter((name) => name === "GuanlanSearch")).toHaveLength(1);
  });

  test("activateTools reports promoted names through onToolsActivated", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "probe-1", name: "ProbeTool", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const activations: string[][] = [];
    const probeTool = {
      name: "ProbeTool",
      description: "probe",
      inputSchema: { type: "object" as const, properties: {} },
      async call(_input: unknown, context: ToolContext) {
        context.activateTools?.(["GuanlanSearch", "NoSuchTool"]);
        // Second call promotes nothing: no callback, no duplicate report.
        context.activateTools?.(["GuanlanSearch"]);
        return { type: "tool_result" as const, tool_use_id: "", content: "probe done" };
      }
    };
    const deferredTool = {
      name: "GuanlanSearch",
      description: "search guanlan",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "guanlan" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [probeTool],
      deferredTools: [deferredTool],
      onToolsActivated: (names) => activations.push([...names]),
      systemPrompt: "test",
      maxTurns: 5,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(activations).toEqual([["GuanlanSearch"]]);
  });

  test("listAvailableTools returns native plus deferred tools live", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "probe-1", name: "ProbeTool", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    let before: string[] = [];
    let after: string[] = [];
    const probeTool = {
      name: "ProbeTool",
      description: "probe",
      inputSchema: { type: "object" as const, properties: {} },
      async call(_input: unknown, context: ToolContext) {
        before = (context.listAvailableTools?.() ?? []).map((tool) => tool.name);
        context.activateTools?.(["GuanlanSearch"]);
        after = (context.listAvailableTools?.() ?? []).map((tool) => tool.name);
        return { type: "tool_result" as const, tool_use_id: "", content: "probe done" };
      }
    };
    const nativeTool = {
      name: "NativeTool",
      description: "native",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "native" };
      }
    };
    const deferredTool = {
      name: "GuanlanSearch",
      description: "search guanlan",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "guanlan" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [probeTool, nativeTool],
      deferredTools: [deferredTool],
      systemPrompt: "test",
      maxTurns: 5,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(before).toEqual(["ProbeTool", "NativeTool", "GuanlanSearch"]);
    // After promotion the deferred tool is native, so the live catalog still lists it exactly once.
    expect(after).toEqual(["ProbeTool", "NativeTool", "GuanlanSearch"]);
  });

  test("ToolSearch end to end: constructor rebinding, native promotion, and deferred removal", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "search-1", name: "ToolSearch", input: { query: "select:GuanlanSearch" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "tool_use", id: "guanlan-1", name: "GuanlanSearch", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    let guanlanCalls = 0;
    const deferredTool = {
      name: "GuanlanSearch",
      description: "search guanlan",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        guanlanCalls += 1;
        return { type: "tool_result" as const, tool_use_id: "", content: "guanlan result" };
      }
    };

    // Real factory output bound to an empty pool: only the engine's
    // construction-time rebinding can see the deferred tools.
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [createToolSearchTool(() => [])],
      deferredTools: [deferredTool],
      systemPrompt: "test",
      maxTurns: 5,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(provider.requests).toHaveLength(3);
    // Turn 1 result carries the direct-call guidance from the rebound ToolSearch.
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("call them directly by name");
    // Turn 2 request exposes the promoted tool natively, exactly once.
    const turnTwoNames = (provider.requests[1]?.tools ?? []).map((tool) => tool.name);
    expect(turnTwoNames).toContain("GuanlanSearch");
    expect(turnTwoNames.filter((name) => name === "GuanlanSearch")).toHaveLength(1);
    // The promoted tool executed natively and its result reached the final turn.
    expect(guanlanCalls).toBe(1);
    expect(JSON.stringify(provider.requests[2]?.messages)).toContain("guanlan result");
    // Promotion removed the tool from the deferred pool.
    const deferredNames = ((engine as any).config.deferredTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(deferredNames).not.toContain("GuanlanSearch");
  });
});

describe("QueryEngine usage records", () => {
  test("emits assistant usage and final billing/context usage contract", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30
      }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "gpt-4o-mini",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      sessionId: "thread-usage"
    });

    const events = await collectEvents(engine);
    const assistant = events.find((event) => (event as { type?: string }).type === "assistant") as any;
    const result = events.find((event) => (event as { type?: string }).type === "result") as any;

    expect(assistant.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 0,
      totalTokens: 150
    });
    expect(assistant.usageIdentity).toMatchObject({
      threadId: "thread-usage",
      callerKind: "conversation",
      turn: 1
    });
    expect(result.billingUsage.cumulative).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 0,
      totalTokens: 150
    });
    expect(result.billingUsage.latestRecord).toMatchObject({
      outputTokens: 20,
      usageIdentity: expect.objectContaining({ callerKind: "conversation" })
    });
    expect(result.contextUsage).toMatchObject({
      source: "provider",
      totalTokens: 150,
      contextWindow: 128_000
    });
  });

  test("usageIdentity.runId prefers config.runId over sessionId (#256)", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "gpt-4o-mini",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      sessionId: "thread-runid",
      runId: "run-42"
    });

    const events = await collectEvents(engine);
    const assistant = events.find((event) => (event as { type?: string }).type === "assistant") as any;
    // 此前恒用 sessionId(=threadId),无法按 run 聚合 usage
    expect(assistant.usageIdentity).toMatchObject({ threadId: "thread-runid", runId: "run-42" });
  });

  test("includes per-provider-call usage records in the final result", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
        stopReason: "tool_use",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10
        }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: {
          input_tokens: 60,
          output_tokens: 15,
          cache_read_input_tokens: 5
        }
      }
    ]);
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "gpt-4o-mini",
      provider,
      tools: [readTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    const events = await collectEvents(engine);
    const result = events.find((event) => (event as { type?: string }).type === "result") as any;

    expect(result.usageRecords).toEqual([
      expect.objectContaining({
        callerLabel: "Turn 1",
        model: "gpt-4o-mini",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        turn: 1
      }),
      expect.objectContaining({
        callerLabel: "Turn 2",
        model: "gpt-4o-mini",
        inputTokens: 60,
        outputTokens: 15,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
        turn: 2
      })
    ]);
  });
});

describe("QueryEngine structured tool results", () => {
  test("keeps array tool results instead of JSON stringifying them", async () => {
    const structuredTool = {
      name: "js",
      description: "structured",
      inputSchema: { type: "object" as const, properties: {} },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: [
            { type: "text", text: "ready" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
          ],
          _meta: {
            traceId: "t-1",
            computerUseAction: {
              actionId: "action-1",
              action: "click",
              phase: "observed",
              window: { id: 42, app: "微信" },
            },
          },
        };
      },
    };
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        {
          content: [{ type: "tool_use", id: "tool-1", name: "js", input: {} }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]),
      tools: [structuredTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
    });

    const events = await collectEvents(engine);

    const toolResultMessage = engine.getMessages().find((msg) =>
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      msg.content.some((block: any) => block.type === "tool_result"),
    );

    expect(toolResultMessage).toBeDefined();
    expect((toolResultMessage!.content as any[])[0].content).toEqual([
      { type: "text", text: "ready" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
    ]);
    expect((toolResultMessage!.content as any[])[0]._meta).toMatchObject({ traceId: "t-1" });
    expect((engine as any).provider.requests[1].system).toBe("test");
    expect((engine as any).provider.requests[1].messages).toContainEqual(expect.objectContaining({
      role: "runtime",
      content: expect.stringContaining("action-1: click on 微信#42; phase=observed; not verified complete"),
    }));
    const streamedToolResult = events.find((event: any) => event.type === "tool_result") as any;
    expect(streamedToolResult.result.output).not.toContain("ZmFrZQ==");
    expect(streamedToolResult.result.output).toContain("[Image: image/png]");
  });

  test("strips internal image metadata before provider calls", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
    });
    (engine as any).messages.push({
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "old" },
        _meta: { persist: false },
      }],
    });
    (engine as any).messages.push({
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "desktop-context",
        name: "current_context",
        input: {},
        _meta: { traceId: "tool-use" },
      }],
    });
    (engine as any).messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "desktop-context",
        content: [{
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "nested" },
          _meta: { persist: false },
        }],
        _meta: { traceId: "tool-result" },
      }],
    });

    await collectEvents(engine, [
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" },
        _meta: { persist: false },
      },
    ] as any);

    expect(JSON.stringify((provider as any).requests?.[0]?.messages)).not.toContain("_meta");
  });
});

describe("QueryEngine skill catalog injection", () => {
  test("appends an available_skills runtime message on every model call", async () => {
    const registry = new SkillRegistry([{
      name: "commit",
      description: "Create a git commit",
      getPrompt: async () => [{ type: "text", text: "commit" }],
    }])
    const provider = new StaticProvider([
      { content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "commit" } }], stopReason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],          // Skill 工具不必真注册：目录注入独立于工具执行
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      skillRegistry: registry,
    })

    await collectEvents(engine)

    expect(provider.requests).toHaveLength(2)
    for (const request of provider.requests) {
      const runtime = request.messages.filter((m: any) => m.role === "runtime")
      expect(runtime.length).toBeGreaterThanOrEqual(1)
      expect(runtime.at(-1)?.content).toContain("<available_skills>")
      expect(String(runtime.at(-1)?.content)).toContain("- commit: Create a git commit")
    }
  })

  test("injects no catalog message when the registry is empty", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      skillRegistry: new SkillRegistry(),
    })

    await collectEvents(engine)

    const runtimeMessages = provider.requests[0].messages.filter((m: any) => m.role === "runtime")
    expect(runtimeMessages.some((m: any) => String(m.content).includes("<available_skills>"))).toBe(false)
  })
});

describe("QueryEngine getContextUsage", () => {
  const dummyTool = {
    name: "Bash",
    description: "run a command",
    inputSchema: { type: "object", properties: {} },
    async call() {
      return { type: "tool_result" as const, tool_use_id: "", content: "ok" }
    },
  }

  test("pairs tool_result tokens with the originating tool via tool_use id", () => {
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([]),
      tools: [dummyTool],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
    })
    engine.messages.push(
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "result payload" }] },
    )

    const usage = engine.getContextUsage()
    const byName = new Map(usage.messageBreakdown.toolCallsByType.map((entry) => [entry.name, entry]))
    expect(byName.get("Bash")?.callTokens).toBeGreaterThan(0)
    expect(byName.get("Bash")?.resultTokens).toBeGreaterThan(0)
    expect(byName.has("tool_result")).toBe(false)
  })

  test("honors config.contextWindow override instead of the model lookup", () => {
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([]),
      tools: [dummyTool],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      contextWindow: 12345,
    })
    engine.messages.push({ role: "user", content: "go" })

    expect(engine.getContextUsage().maxTokens).toBe(12345)
  })

  test("tool schema token estimate includes inputSchema (#389)", () => {
    const buildEngine = (inputSchema: Record<string, unknown>) =>
      new QueryEngine({
        cwd: process.cwd(),
        model: "test-model",
        provider: new StaticProvider([]),
        tools: [{ ...dummyTool, name: "Bash", inputSchema }],
        systemPrompt: "test",
        maxTurns: 1,
        maxTokens: 100000,
      })

    const bigSchemaUsage = buildEngine({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`property${i}`, { type: "string" }]),
      ),
    }).getContextUsage()
    const smallSchemaUsage = buildEngine({ type: "object", properties: {} }).getContextUsage()

    const toolsTokens = (usage: ReturnType<QueryEngine["getContextUsage"]>) =>
      usage.categories.find((category) => category.name === "tools")?.tokens ?? 0

    // 口径与 getDeferredToolTokenCount 一致：schema 变大必须推高估算，
    // 不依赖 native 计数是否可用（双态稳健）。
    expect(toolsTokens(bigSchemaUsage)).toBeGreaterThan(toolsTokens(smallSchemaUsage))
  })
});

describe("QueryEngine max_tokens continuation (#304/#361)", () => {
  test("pairs truncated tool_use blocks with placeholders before the continuation prompt", async () => {
    const provider = new StaticProvider([
      {
        content: [
          { type: "text", text: "partial answer" },
          { type: "tool_use", id: "trunc-1", name: "Read", input: { file_path: "a.ts" } },
        ],
        stopReason: "max_tokens",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        content: [{ type: "text", text: "continued" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          throw new Error("must not execute a truncated tool call")
        }
      }],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false
    })

    const secondRequest = provider.requests[1]
    // The truncated assistant tool_use is answered by an error placeholder
    // paired with the continuation prompt in one user message (#304).
    expect(secondRequest?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: [
          expect.objectContaining({
            type: "tool_result",
            tool_use_id: "trunc-1",
            is_error: true
          }),
          expect.objectContaining({
            type: "text",
            text: "Please continue from where you left off."
          })
        ]
      })
    ]))
  })

  test("maps an exhausted truncated continuation to error_max_output_tokens instead of success", async () => {
    const truncated = (): CreateMessageResponse => ({
      content: [{ type: "text", text: "still going and" }],
      stopReason: "max_tokens",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([truncated(), truncated(), truncated(), truncated()]),
      tools: [],
      systemPrompt: "test",
      maxTurns: 10,
      maxTokens: 256,
      includePartialMessages: false
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "error_max_output_tokens",
      is_error: true
    })
  })

  test("executes truncated tool calls once the continuation budget is spent", async () => {
    let calls = 0
    const truncatedText = (): CreateMessageResponse => ({
      content: [{ type: "text", text: "still going and" }],
      stopReason: "max_tokens",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        truncatedText(),
        truncatedText(),
        truncatedText(),
        {
          // Continuations exhausted: a truncated tool_use still executes.
          content: [{ type: "tool_use", id: "t-1", name: "Bash", input: {} }],
          stopReason: "max_tokens",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "text", text: "done after tools" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [{
        name: "Bash",
        description: "bash",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls += 1
          return { type: "tool_result", tool_use_id: "", content: `result ${calls}` }
        }
      }],
      systemPrompt: "test",
      maxTurns: 8,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false
    })
    expect(calls).toBe(1)
  })
})

describe("QueryEngine non-stream retry events (#360)", () => {
  function flakyProvider(failures: number): { provider: LLMProvider; calls(): number } {
    let count = 0
    return {
      calls: () => count,
      provider: {
        apiType: "anthropic-messages" as const,
        async createMessage() {
          count += 1
          if (count <= failures) {
            const error = new Error("overloaded") as Error & { status: number }
            error.status = 503
            throw error
          }
          return {
            content: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        }
      }
    }
  }

  test("delivers api_retry through onAsyncEvent while the backoff is still running", async () => {
    const { provider, calls } = flakyProvider(1)
    const asyncEvents: SDKMessage[] = []
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      onAsyncEvent: (event) => asyncEvents.push(event)
    })

    const running = collectEvents(engine)
    // Poll until the second attempt starts; by then attempt 1 must already
    // have been delivered instead of waiting for withRetry to unwind.
    for (let i = 0; i < 200 && calls() < 2; i++) {
      await wait(25)
    }
    expect(calls()).toBe(2)
    expect(asyncEvents).toHaveLength(1)
    expect(asyncEvents[0]).toMatchObject({ subtype: "api_retry", attempt: 1, error_status: 503 })

    const events = await running
    // Already delivered via onAsyncEvent — not duplicated into the stream.
    expect(events.filter((event) => (event as { subtype?: string }).subtype === "api_retry")).toHaveLength(0)
  }, 20_000)

  test("buffers api_retry into the stream when no host callback is configured", async () => {
    const { provider } = flakyProvider(1)
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false
    })

    const events = await collectEvents(engine)
    const retries = events.filter((event) =>
      event.type === "system" && (event as { subtype?: string }).subtype === "api_retry"
    ) as Array<{ attempt: number; error_status: number | null }>
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ attempt: 1, error_status: 503 })
  }, 20_000)
})

describe("QueryEngine cost estimation (#352)", () => {
  test("includes cache read/write tokens in billing totals", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: {
        input_tokens: 1000,
        output_tokens: 1000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 100_000
      }
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "claude-sonnet-4-6",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false
    })

    const result = await collectResult(engine) as unknown as {
      billingUsage: { totalCostUSD: number; cumulative: { totalTokens: number } }
      modelUsage: Record<string, { costUSD: number }>
    }

    const expected =
      1000 * 3 / 1e6
      + 1000 * 15 / 1e6
      + 1_000_000 * 3 / 1e6 * 0.1
      + 100_000 * 3 / 1e6 * 1.25
    expect(result.billingUsage.totalCostUSD).toBeCloseTo(expected, 10)
    expect(result.modelUsage["claude-sonnet-4-6"]?.costUSD).toBeCloseTo(expected, 10)
    expect(result.billingUsage.cumulative.totalTokens).toBe(1_102_000)
  })
})

describe("QueryEngine end_turn with tool_use (#568)", () => {
  test("keeps looping when end_turn carries tool calls so the model sees results", async () => {
    let toolCalls = 0
    const provider = new StaticProvider([
      {
        // Gateway reports finish_reason "stop" (mapped to end_turn) while
        // still requesting a tool call.
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t-end-1", name: "Echo", input: { q: "state" } },
        ],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        content: [{ type: "text", text: "done after result" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        async call() {
          toolCalls += 1
          return { type: "tool_result", tool_use_id: "", content: "executed" }
        }
      }],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false
    })
    expect(toolCalls).toBe(1)

    // The follow-up request must carry the executed tool_result back to the
    // model instead of ending the run with it unanswered.
    const secondRequest = provider.requests[1]
    expect(secondRequest?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "tool_result",
            tool_use_id: "t-end-1",
            content: "executed"
          })
        ])
      })
    ]))
  })

  test("ends the run on a tool-free end_turn response", async () => {
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        {
          content: [{ type: "text", text: "plain answer" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]),
      tools: [],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false
    })
  })

  test("feeds denied tool results back and keeps looping when end_turn carries tool calls (#618)", async () => {
    let executed = 0
    const provider = new StaticProvider([
      {
        // 网关在 end_turn 上携带 tool_use，而 canUseTool 全量拒绝：
        // deny 结果必须作为 tool_result 回灌让模型看到，循环继续而非终局。
        content: [
          { type: "text", text: "try it" },
          { type: "tool_use", id: "t-deny-1", name: "Echo", input: { q: "state" } },
        ],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        content: [{ type: "text", text: "done without tools" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        async call() {
          executed += 1
          return { type: "tool_result", tool_use_id: "", content: "should not run" }
        }
      }],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "deny", message: "blocked by policy" })
    })

    // 第二轮模型看到 deny 结果后干净收场：循环未因 end_turn+tool_use 提前断裂
    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false
    })
    expect(executed).toBe(0)

    // 回灌断言：deny 结果（is_error + 拒绝文案）必须出现在下一轮请求里
    const secondRequest = provider.requests[1]
    expect(secondRequest?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "tool_result",
            tool_use_id: "t-deny-1",
            is_error: true,
          })
        ])
      })
    ]))
    const fedBack = JSON.stringify(secondRequest?.messages)
    expect(fedBack).toContain("blocked by policy")
  })

  test("emits prompt_suggestions tool summary for an end_turn+tool_use turn (#618)", async () => {
    // 旧语义下 end_turn+tool_use 在执行工具前就提前 break，tool_use_summary
    // 对这类轮次不可达；删行后该分支必须照常产出。
    const provider = new StaticProvider([
      {
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "t-sugg-1", name: "Echo", input: { q: 1 } },
        ],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "executed" }
        }
      }],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false,
      promptSuggestions: true
    })

    const events = await collectEvents(engine)
    const summaries = events.filter((event) => (event as { type?: string }).type === "tool_use_summary")
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      summary: "Used tools: Echo",
      preceding_tool_use_ids: ["t-sugg-1"],
    })
  })

  test("bounds a gateway that always answers stop with tool calls via maxTurns", async () => {
    let calls = 0
    const stopWithToolCall = (round: number): CreateMessageResponse => ({
      content: [
        { type: "text", text: `round ${round}` },
        {
          // Distinct inputs keep the repeat guard out of the way so this
          // exercises the maxTurns bound specifically.
          type: "tool_use",
          id: `t-loop-${round}`,
          name: "Echo",
          input: { n: round },
        },
      ],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        stopWithToolCall(0),
        stopWithToolCall(1),
        stopWithToolCall(2),
        stopWithToolCall(3),
      ]),
      tools: [{
        name: "Echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls += 1
          return { type: "tool_result", tool_use_id: "", content: `result ${calls}` }
        }
      }],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "error_max_turns",
      is_error: true
    })
    expect(calls).toBeLessThanOrEqual(3)
  })
})

describe("QueryEngine session file-state (#569)", () => {
  test("shares one file-state cache across engines so read-before-edit survives runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-engine-filestate-"))
    const filePath = join(root, "note.txt")
    writeFileSync(filePath, "alpha\n", "utf8")
    try {
      const cache = new FileStateCache()
      const makeRun = (
        responses: CreateMessageResponse[],
        sharedCache?: FileStateCache,
      ) => new QueryEngine({
        cwd: root,
        model: "test-model",
        provider: new StaticProvider(responses),
        tools: [FileReadTool, FileEditTool],
        systemPrompt: "test",
        maxTurns: 2,
        maxTokens: 256,
        ...(sharedCache ? { fileStateCache: sharedCache } : {}),
      })

      // Run 1（引擎 A）：真实引擎路径 Read，建立线程级记录。
      await collectEvents(makeRun([
        {
          content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: filePath } }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        {
          content: [{ type: "text", text: "read done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ], cache))

      // Run 2（引擎 B，同一共享 cache）：跨 run 无需重读即可编辑。
      const editEvents = await collectEvents(makeRun([
        {
          content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: filePath, old_string: "alpha", new_string: "beta" } }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        {
          content: [{ type: "text", text: "edit done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ], cache)) as Array<{ type: string; result?: { is_error: boolean; content?: string } }>
      const editResult = editEvents.find((event) => event.type === "tool_result")
      expect(editResult?.result?.is_error).toBe(false)
      expect(readFileSync(filePath, "utf8")).toContain("beta")

      // 对照组：不接共享 cache 的独立引擎按未读拦截。
      const guardedEvents = await collectEvents(makeRun([
        {
          content: [{ type: "tool_use", id: "e2", name: "Edit", input: { file_path: filePath, old_string: "beta", new_string: "gamma" } }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ])) as Array<{ type: string; result?: { is_error: boolean; content?: string } }>
      const guardedResult = guardedEvents.find((event) => event.type === "tool_result")
      expect(guardedResult?.result?.is_error).toBe(true)
      expect(guardedResult?.result?.content).toContain("has not been read")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("one batch of [Read, Edit] keeps partition order so the Edit sees the fresh read", async () => {
    // 分区不变量：Read 落并发桶且 allSettled 先于串行桶执行，同回合批量
    // [Read, Edit] 不得因并行化静默退化成 not_read。
    const root = mkdtempSync(join(tmpdir(), "lume-engine-filestate-"))
    const filePath = join(root, "note.txt")
    writeFileSync(filePath, "alpha\n", "utf8")
    try {
      const events = await collectEvents(new QueryEngine({
        cwd: root,
        model: "test-model",
        provider: new StaticProvider([
          {
            content: [
              { type: "tool_use", id: "r1", name: "Read", input: { file_path: filePath } },
              { type: "tool_use", id: "e1", name: "Edit", input: { file_path: filePath, old_string: "alpha", new_string: "beta" } },
            ],
            stopReason: "tool_use",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          {
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ]),
        tools: [FileReadTool, FileEditTool],
        systemPrompt: "test",
        maxTurns: 2,
        maxTokens: 256,
      })) as Array<{ type: string; result?: { is_error: boolean; tool_name?: string } }>
      const results = events.filter((event) => event.type === "tool_result")
      expect(results.map((event) => event.result?.tool_name)).toEqual(["Read", "Edit"])
      for (const event of results) expect(event.result?.is_error).toBe(false)
      expect(readFileSync(filePath, "utf8")).toBe("beta\n")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("external modification between shared-cache runs trips stale_read and keeps disk intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-engine-filestate-"))
    const filePath = join(root, "note.txt")
    writeFileSync(filePath, "alpha\n", "utf8")
    try {
      const cache = new FileStateCache()
      const makeRun = (responses: CreateMessageResponse[]) => new QueryEngine({
        cwd: root,
        model: "test-model",
        provider: new StaticProvider(responses),
        tools: [FileReadTool, FileEditTool],
        systemPrompt: "test",
        maxTurns: 2,
        maxTokens: 256,
        fileStateCache: cache,
      })

      await collectEvents(makeRun([
        {
          content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: filePath } }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        {
          content: [{ type: "text", text: "read done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]))

      // Run 间隙外部进程改写；强制 mtime 前移避免同毫秒抖动。
      writeFileSync(filePath, "tampered\n", "utf8")
      const stats = statSync(filePath)
      utimesSync(filePath, stats.atime, new Date(stats.mtimeMs + 5000))

      const editEvents = await collectEvents(makeRun([
        {
          content: [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: filePath, old_string: "tampered", new_string: "hacked" } }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ])) as Array<{ type: string; result?: { is_error: boolean; content?: string }; _meta?: { file?: { conflict?: string } } }>
      const editResult = editEvents.find((event) => event.type === "tool_result")
      expect(editResult?.result?.is_error).toBe(true)
      expect(editResult?.result?.content).toContain("has been modified since it was read")
      expect(readFileSync(filePath, "utf8")).toBe("tampered\n")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("QueryEngine isEnabled injection filter (#700)", () => {
  function makeGatedTool(enabled: () => boolean) {
    return {
      name: "gmail_send_email",
      description: "send email",
      inputSchema: { type: "object" as const, properties: {} },
      isEnabled: enabled,
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "sent" }
      }
    }
  }

  function makeReadTool() {
    return {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" }
      }
    }
  }

  function makeObservedProvider(responses: CreateMessageResponse[]) {
    const observedTools: string[][] = []
    const provider = new StaticProvider(responses)
    const originalCreateMessage = provider.createMessage.bind(provider)
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort())
      return originalCreateMessage(params)
    }
    return { provider, observedTools }
  }

  test("tools with isEnabled=false never reach the provider request", async () => {
    const { provider, observedTools } = makeObservedProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [makeReadTool(), makeGatedTool(() => false)],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await collectResult(engine)

    // 未启用的工具不占 prompt 预算;常驻工具不受影响
    expect(observedTools[0]).toEqual(["Read"])
  })

  test("re-evaluates isEnabled each turn: reconnecting restores injection", async () => {
    let connected = false
    const { provider, observedTools } = makeObservedProvider([
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [{ type: "text", text: "done again" }], stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [makeReadTool(), makeGatedTool(() => connected)],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await collectResult(engine)
    expect(observedTools[0]).toEqual(["Read"])

    // 同一会话中途连接凭证后,下一轮请求即恢复注入(每轮重新求值,不得缓存)
    connected = true
    await collectResult(engine)
    expect(observedTools[1]).toEqual(["Read", "gmail_send_email"])
  })
})

