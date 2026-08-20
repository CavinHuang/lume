import { describe, expect, test } from "bun:test"
import { QueryEngine } from "./engine.js"
import type {
  CreateMessageParams,
  CreateMessageResponse,
  CreateMessageStreamEvent,
  LLMProvider,
} from "./providers/types.js"

const FINAL_RESPONSE: CreateMessageResponse = {
  content: [{ type: "text", text: "Hello world" }],
  stopReason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 2 },
}

/**
 * 模拟 pi-ai provider 的中途重试：第一次 attempt 已流出 "Hello" 后失败，
 * 重试成功后从头重发全量 delta（重复前缀）再补全 " world"。
 */
class RetryingStreamProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    return FINAL_RESPONSE
  }

  async *createMessageStream(
    _params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    yield { type: "text_delta", text: "Hello" }
    yield { type: "retry_state", phase: "waiting", attempt: 1, maxRetries: 3, retryDelayMs: 1, errorStatus: 503 }
    yield { type: "retry_state", phase: "retrying", attempt: 1, maxRetries: 3, retryDelayMs: 0, errorStatus: 503 }
    // 重试成功：从头重发（attempt 1 的 delta 无法撤回，这是 #160 的缺陷现场）
    yield { type: "text_delta", text: "Hello" }
    yield { type: "text_delta", text: " world" }
    return FINAL_RESPONSE
  }
}

/** 重试发生在任何 delta 之前：无重复风险，delta 应照常转发。 */
class RetryBeforeDeltaProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const

  async createMessage(_params: CreateMessageParams): Promise<CreateMessageResponse> {
    return FINAL_RESPONSE
  }

  async *createMessageStream(
    _params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    yield { type: "retry_state", phase: "waiting", attempt: 1, maxRetries: 3, retryDelayMs: 1, errorStatus: 429 }
    yield { type: "retry_state", phase: "retrying", attempt: 1, maxRetries: 3, retryDelayMs: 0, errorStatus: 429 }
    yield { type: "text_delta", text: "Hello world" }
    return FINAL_RESPONSE
  }
}

function buildEngine(provider: LLMProvider): QueryEngine {
  return new QueryEngine({
    cwd: process.cwd(),
    model: "test-model",
    provider,
    tools: [],
    systemPrompt: "test",
    maxTurns: 1,
    maxTokens: 256,
    includePartialMessages: true,
  })
}

function streamTextDeltas(events: unknown[]): string[] {
  return events
    .filter((event) => {
      const candidate = event as { type: string; event?: { type: string; delta?: { type?: string } } }
      return candidate.type === "stream_event"
        && candidate.event?.type === "content_block_delta"
        && candidate.event.delta?.type === "text_delta"
    })
    .map((event) => (event as { event: { delta: { text?: string } } }).event.delta.text ?? "")
}

describe("engine 流重试 delta 抑制（#160）", () => {
  test("delta 已流出后中途重试：重发 delta 不再转发，api_retry 事件保留，final 完整", async () => {
    const engine = buildEngine(new RetryingStreamProvider())
    const events: unknown[] = []
    for await (const event of engine.submitMessage("run")) {
      events.push(event)
    }

    // 只保留第一次 attempt 的 delta，重试后的重复 "Hello" 与补全 " world" 被抑制
    expect(streamTextDeltas(events)).toEqual(["Hello"])

    // retry_state 照常转发为 api_retry 系统事件
    const retries = events.filter((event) => (event as { type: string; subtype?: string }).type === "system"
      && (event as { subtype?: string }).subtype === "api_retry") as Array<{ phase: string }>
    expect(retries.map((event) => event.phase)).toEqual(["waiting", "retrying"])

    // 最终消息以 done 的完整 response 为权威，不受抑制影响
    const finalText = engine.getMessages().findLast((message) => message.role === "assistant")?.content
    expect(JSON.stringify(finalText)).toContain("Hello world")
  })

  test("重试发生在首个 delta 之前：不抑制，流式正常", async () => {
    const engine = buildEngine(new RetryBeforeDeltaProvider())
    const events: unknown[] = []
    for await (const event of engine.submitMessage("run")) {
      events.push(event)
    }
    expect(streamTextDeltas(events)).toEqual(["Hello world"])
  })
})
