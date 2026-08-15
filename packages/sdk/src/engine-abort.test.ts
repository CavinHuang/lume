import { describe, expect, test } from "bun:test"
import { QueryEngine } from "./engine.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"
import type { ToolContext } from "./types.js"

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

const tool = (name: string, opts: { slow?: boolean } = {}) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  isReadOnly: () => !opts.slow,
  async call(_input: unknown, context: ToolContext) {
    if (opts.slow) {
      // Real tools observe the abort signal; mimic that so the run can finalize.
      return new Promise<never>((_resolve, reject) => {
        context.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("tool aborted")),
          { once: true },
        )
      })
    }
    return { type: "tool_result" as const, tool_use_id: "", content: `${name} done` }
  },
})

describe("soft abort semantics", () => {
  test("abort keeps completed tool results and fills interrupted placeholders", async () => {
    const provider = new StaticProvider([{
      content: [
        { type: "tool_use", id: "fast", name: "Read", input: {} },
        { type: "tool_use", id: "slow", name: "Bash", input: {} },
      ],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])

    const abort = new AbortController()
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [tool("Read"), tool("Bash", { slow: true })],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      abortSignal: abort.signal,
    })

    const events: any[] = []
    const collecting = (async () => {
      for await (const event of engine.submitMessage("run")) events.push(event)
    })()

    // Let the read-only tool finish first, then abort while Bash is mid-flight.
    await new Promise((r) => setTimeout(r, 50))
    abort.abort("interrupt")
    await collecting

    const toolResults = events.filter((e) => e.type === "tool_result").map((e) => e.result)
    const byId = Object.fromEntries(toolResults.map((r: any) => [r.tool_use_id, r]))
    expect(byId.fast).toBeTruthy()          // completed: result kept
    expect(byId.slow?.is_error).toBe(true)  // interrupted: placeholder
    expect(String(byId.slow?.content)).toContain("interrupted")
    expect(engine.getMessages().at(-1)?.role).toBe("user") // tool_result pushed, no dangling tool_use
  })

  test("emits run_aborted async event with pending tool calls", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const asyncEvents: any[] = []
    const abort = new AbortController()
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [tool("Bash", { slow: true })],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false,
      onAsyncEvent: (event) => asyncEvents.push(event),
      abortSignal: abort.signal,
    })
    const collecting = (async () => {
      for await (const event of engine.submitMessage("run")) {
        // drain
      }
    })()
    await new Promise((r) => setTimeout(r, 50))
    abort.abort("interrupt")
    await collecting

    const aborted = asyncEvents.find((e) => e.subtype === "run_aborted")
    expect(aborted?.pending_tool_calls).toEqual([
      { id: "t1", name: "Bash", input: { command: "x" } },
    ])
  })

  test("skips continuations whose tool_use_id already has a tool_result in history", async () => {
    // Regression: after a soft abort the engine persists error placeholders for
    // the interrupted tools. A resume that injects/executes a continuation for
    // the same id must be a no-op, or the provider request carries two
    // tool_results for one tool_use (Anthropic 400).
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [tool("Read")],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      toolContinuations: [{
        toolCall: { id: "t1", name: "Read", input: {} },
        toolResult: {
          type: "tool_result",
          tool_use_id: "t1",
          content: "injected duplicate result",
          is_error: true,
        },
      }],
    })
    engine.messages.push(
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Error: interrupted placeholder", is_error: true }] },
    )

    const events: any[] = []
    for await (const event of engine.submitMessage("")) {
      events.push(event)
    }

    const payload = JSON.stringify(provider.requests[0]?.messages)
    const t1Results = payload.match(/"tool_use_id":\s*"t1"/g) ?? []
    expect(t1Results).toHaveLength(1)
    expect(payload).not.toContain("injected duplicate result")
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(0)
    // No empty-content user message is appended for the skipped continuation.
    expect(
      engine.getMessages().some((m) => Array.isArray(m.content) && m.content.length === 0)
    ).toBe(false)
  })
})
