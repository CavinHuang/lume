import { OpenAIProvider } from "./openai.js"

interface DeepSeekMessage {
  role?: string
  content?: unknown
  tool_calls?: unknown[]
}

function normalizeDeepSeekMessages(body: Record<string, any>): void {
  if (!Array.isArray(body.messages)) return

  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue

    const item = message as DeepSeekMessage
    if (item.role !== "assistant") continue

    if (Array.isArray(item.tool_calls) && item.tool_calls.length === 0) {
      delete item.tool_calls
    }

    if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0 && item.content == null) {
      item.content = ""
    }
  }
}

export class DeepSeekProvider extends OpenAIProvider {
  readonly apiType = "deepseek-chat-completions" as const

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    super({
      ...opts,
      baseURL: opts.baseURL || "https://api.deepseek.com/v1",
    })
  }

  protected prepareChatCompletionBody(body: Record<string, any>): void {
    normalizeDeepSeekMessages(body)
  }
}
