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
})
