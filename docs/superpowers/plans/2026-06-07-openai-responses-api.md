# OpenAI Responses API 适配实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 适配 OpenAI Responses API (`/v1/responses`)，使其与现有 Chat Completions API (`/v1/chat/completions`) 并行工作。

**Architecture:** 在 SDK 层新增 `OpenAIResponsesProvider`（用于 Agent 流式对话），在 Sidecar 层新增 `OpenAIResponsesAdapter`（用于标题生成）。通过 `Channel.openaiApiMode` 字段让用户选择 API 模式。消息格式在统一内部表示（Anthropic-like）和 Responses API 格式之间双向转换。

**Tech Stack:** TypeScript, 原生 fetch API, SSE 流式解析, Vitest 测试框架

---

## Responses API vs Chat Completions API 关键差异

| 维度 | Chat Completions | Responses API |
|------|-----------------|---------------|
| **端点** | `POST /v1/chat/completions` | `POST /v1/responses` |
| **输入字段** | `messages` 数组 | `input` 数组 + `instructions` |
| **System 消息** | `messages` 中 `{ role: "system" }` | 顶层 `instructions` 字段 |
| **工具调用输出** | `{ role: "tool", tool_call_id, content }` | `{ type: "function_call_output", call_id, output }` |
| **助手工具调用** | `tool_calls` in assistant message | `{ type: "function_call", call_id, name, arguments }` |
| **响应格式** | `{ choices: [{ message: {...} }] }` | `{ output: [{ type: "message", ... }] }` |
| **流式事件** | `data: { choices: [{ delta }] }` + `[DONE]` | 事件类型化：`response.output_text.delta` 等 |
| **文本输出** | `choices[0].message.content` | `output[].content[].text` |
| **图片输入** | `{ type: "image_url", image_url: {...} }` | `{ type: "input_image", image_url: {...} }` |

## 文件结构

```
修改:
  packages/shared/src/types/channel.ts       — Channel 添加 openaiApiMode 字段
  packages/sdk/src/providers/types.ts         — ApiType 添加 'openai-responses'
  packages/sdk/src/providers/index.ts         — 工厂注册新 provider
  packages/sdk/src/agent.ts                   — resolveApiType 识别 responses 模式
  apps/sidecar/src/providers/index.ts         — 注册新 adapter + 修改 getAdapter
  apps/sidecar/src/services/channel/model-selection.ts — 传递 openaiApiMode

创建:
  packages/sdk/src/providers/openai-responses.ts  — SDK Responses API Provider
  packages/sdk/src/providers/openai-responses.test.ts — SDK Provider 单元测试
  apps/sidecar/src/providers/openai-responses-adapter.ts — Sidecar Responses Adapter
  apps/sidecar/src/providers/openai-responses-adapter.test.ts — Adapter 单元测试
```

---

### Task 1: SDK 类型系统 — 添加 `openai-responses` ApiType

**Files:**
- Modify: `packages/sdk/src/providers/types.ts:15`

- [ ] **Step 1: 添加 ApiType 值**

在 `packages/sdk/src/providers/types.ts` 第 15 行，扩展 `ApiType`：

```typescript
export type ApiType = 'anthropic-messages' | 'openai-completions' | 'deepseek-chat-completions' | 'openai-responses'
```

- [ ] **Step 2: 验证编译通过**

Run: `npx tsc --noEmit -p packages/sdk/tsconfig.json 2>&1 | head -20`
Expected: 无类型错误（或仅有 `createProvider` 缺少 `openai-responses` 分支的 warning）

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/providers/types.ts
git commit -m "feat(sdk): add 'openai-responses' to ApiType union"
```

---

### Task 2: Shared 类型 — Channel 添加 openaiApiMode

**Files:**
- Modify: `packages/shared/src/types/channel.ts` (Channel 接口, 约 278-303 行)

- [ ] **Step 1: 添加类型和字段**

在 `channel.ts` 中：

1. 在 `ProviderApiFamily` 之后添加类型：

```typescript
/** OpenAI API 模式（仅 provider 为 'openai' 时使用） */
export type OpenAiApiMode = 'chat-completions' | 'responses'
```

2. 在 `Channel` 接口中添加字段（在 `apiFamily` 字段后面）：

```typescript
  /** OpenAI API 模式（仅 provider='openai' 时使用，默认 chat-completions） */
  openaiApiMode?: OpenAiApiMode
```

3. 在 `ChannelCreateInput` 接口中也添加：

```typescript
  /** OpenAI API 模式（仅 provider='openai' 时使用） */
  openaiApiMode?: OpenAiApiMode
```

4. 在 `ChannelUpdateInput` 接口中也添加：

```typescript
  /** OpenAI API 模式（仅 provider='openai' 时使用） */
  openaiApiMode?: OpenAiApiMode
```

5. 在 `FetchModelsInput` 接口中也添加：

```typescript
  /** OpenAI API 模式（可选，仅 openai provider 使用） */
  openaiApiMode?: OpenAiApiMode
```

- [ ] **Step 2: 验证编译通过**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json 2>&1 | head -20`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/channel.ts
git commit -m "feat(shared): add openaiApiMode to Channel config"
```

---

### Task 3: SDK Provider — OpenAIResponsesProvider 核心实现

**Files:**
- Create: `packages/sdk/src/providers/openai-responses.ts`
- Create: `packages/sdk/src/providers/openai-responses.test.ts`

- [ ] **Step 1: 编写 Provider 实现文件**

创建 `packages/sdk/src/providers/openai-responses.ts`：

```typescript
/**
 * OpenAI Responses API Provider
 *
 * Converts between the SDK's internal Anthropic-like message format
 * and OpenAI's Responses API format (/v1/responses).
 *
 * Key differences from Chat Completions:
 * - Endpoint: /responses (not /chat/completions)
 * - Input: uses "input" array + top-level "instructions" (not "messages")
 * - Tool results: { type: "function_call_output", call_id, output }
 * - Tool calls: { type: "function_call", call_id, name, arguments }
 * - Response: { output: [...] } (not { choices: [...] })
 * - Streaming: typed events like response.output_text.delta
 */

import type {
  LLMProvider,
  ApiType,
  CreateMessageParams,
  CreateMessageResponse,
  CreateMessageStreamEvent,
  NormalizedMessageParam,
  NormalizedContentBlock,
  NormalizedTool,
  NormalizedResponseBlock,
} from './types.js'
import { DEFAULT_RETRY_CONFIG, type RetryConfig, withRetry } from '../utils/retry.js'

// --------------------------------------------------------------------------
// Responses API types
// --------------------------------------------------------------------------

/** Responses API input item types */
type ResponsesInputItem =
  | { role: 'user' | 'developer'; content: ResponsesInputContent[]; type?: 'message' }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

type ResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

/** Responses API function tool definition */
interface ResponsesFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Responses API non-streaming response */
interface ResponsesApiResponse {
  id: string
  object: 'response'
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress'
  output: ResponsesOutputItem[]
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  error?: { message: string }
}

type ResponsesOutputItem =
  | {
      type: 'message'
      role: 'assistant'
      content: Array<{ type: 'output_text'; text: string } | { type: 'refusal'; refusal: string }>
    }
  | {
      type: 'function_call'
      id: string
      call_id: string
      name: string
      arguments: string
      status: string
    }

/** Responses API streaming event */
interface ResponsesStreamEvent {
  type: string
  delta?: string
  output_index?: number
  content_index?: number
  item?: ResponsesOutputItem
  response?: ResponsesApiResponse
}

function normalizeContentBlocks(content: unknown): NormalizedContentBlock[] {
  if (Array.isArray(content)) return content as NormalizedContentBlock[]
  if (content && typeof content === 'object') return [content as NormalizedContentBlock]
  return []
}

function imageSourceToUrl(source: unknown): string | null {
  if (!source || typeof source !== 'object') return null
  const s = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown }
  if (typeof s.url === 'string' && s.url.trim()) return s.url
  if (s.type === 'base64' && typeof s.media_type === 'string' && typeof s.data === 'string') {
    return `data:${s.media_type};base64,${s.data}`
  }
  return null
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export class OpenAIResponsesProvider implements LLMProvider {
  readonly apiType: ApiType = 'openai-responses'
  private apiKey: string
  private baseURL: string
  private retryConfig: RetryConfig

  constructor(opts: { apiKey?: string; baseURL?: string; retryConfig?: RetryConfig }) {
    this.apiKey = opts.apiKey || ''
    this.baseURL = (opts.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.retryConfig = opts.retryConfig ?? DEFAULT_RETRY_CONFIG
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const { input, tools, instructions } = this.buildRequestParts(params)

    const body: Record<string, unknown> = {
      model: params.model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      max_output_tokens: params.maxTokens,
    }

    if (params.effort) {
      body.reasoning = { effort: params.effort }
    }

    const response = await this.fetchResponse(body)
    const data = (await response.json()) as ResponsesApiResponse
    return this.convertResponse(data)
  }

  async *createMessageStream(
    params: CreateMessageParams,
  ): AsyncGenerator<CreateMessageStreamEvent, CreateMessageResponse> {
    const { input, tools, instructions } = this.buildRequestParts(params)

    const body: Record<string, unknown> = {
      model: params.model,
      input,
      stream: true,
      ...(instructions ? { instructions } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      max_output_tokens: params.maxTokens,
    }

    if (params.effort) {
      body.reasoning = { effort: params.effort }
    }

    const response = await this.fetchResponse(body)

    if (!response.body) {
      throw new Error('OpenAI Responses API returned no response body for streaming request')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let finalResponse: ResponsesApiResponse | undefined
    const textParts: string[] = []
    const functionCalls = new Map<number, { id: string; call_id: string; name: string; arguments: string }>()

    const handleEvent = (event: ResponsesStreamEvent): CreateMessageStreamEvent[] => {
      const events: CreateMessageStreamEvent[] = []

      switch (event.type) {
        case 'response.output_text.delta': {
          if (event.delta) {
            textParts.push(event.delta)
            events.push({ type: 'text_delta', text: event.delta })
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const outputIndex = event.output_index ?? 0
          if (event.delta) {
            const existing = functionCalls.get(outputIndex)
            if (existing) {
              existing.arguments += event.delta
            }
          }
          break
        }
        case 'response.output_item.added': {
          const item = event.item
          if (item && item.type === 'function_call') {
            functionCalls.set(event.output_index ?? functionCalls.size, {
              id: item.id,
              call_id: item.call_id,
              name: item.name,
              arguments: '',
            })
          }
          break
        }
        case 'response.completed': {
          if (event.response) {
            finalResponse = event.response
          }
          break
        }
      }

      return events
    }

    const processBuffer = (flush = false): CreateMessageStreamEvent[] => {
      const events: CreateMessageStreamEvent[] = []
      while (true) {
        const separatorIndex = buffer.indexOf('\n\n')
        if (separatorIndex === -1) break

        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)

        for (const line of frame.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data) continue
          try {
            const parsed = JSON.parse(data) as ResponsesStreamEvent
            events.push(...handleEvent(parsed))
          } catch {
            // skip malformed JSON
          }
        }
      }

      if (flush && buffer.trim().length > 0) {
        for (const line of buffer.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data) continue
          try {
            const parsed = JSON.parse(data) as ResponsesStreamEvent
            events.push(...handleEvent(parsed))
          } catch {
            // skip
          }
        }
      }

      return events
    }

    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      buffer += decoder.decode(value, { stream: true })
      for (const event of processBuffer(false)) {
        yield event
      }
    }

    buffer += decoder.decode()
    for (const event of processBuffer(true)) {
      yield event
    }

    // Build final response
    const content: NormalizedResponseBlock[] = []
    const text = textParts.join('')
    if (text) {
      content.push({ type: 'text', text })
    }

    for (const [, fc] of [...functionCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: any
      try {
        input = JSON.parse(fc.arguments)
      } catch {
        input = fc.arguments
      }
      content.push({
        type: 'tool_use',
        id: fc.call_id || fc.id,
        name: fc.name,
        input,
      })
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    const status = finalResponse?.status
    const stopReason = status === 'incomplete' ? 'max_tokens'
      : functionCalls.size > 0 ? 'tool_use'
      : 'end_turn'

    const usage = finalResponse?.usage
    return {
      content,
      stopReason,
      usage: {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  }

  // --------------------------------------------------------------------------
  // Request building
  // --------------------------------------------------------------------------

  private buildRequestParts(params: CreateMessageParams): {
    input: ResponsesInputItem[]
    tools: ResponsesFunctionTool[] | undefined
    instructions: string | undefined
  } {
    const input = this.convertInput(params.messages)
    const tools = params.tools ? this.convertTools(params.tools) : undefined
    return { input, tools, instructions: params.system || undefined }
  }

  private convertInput(messages: NormalizedMessageParam[]): ResponsesInputItem[] {
    const items: ResponsesInputItem[] = []

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.convertUserMessage(msg, items)
      } else if (msg.role === 'assistant') {
        this.convertAssistantMessage(msg, items)
      }
    }

    return items
  }

  private convertUserMessage(msg: NormalizedMessageParam, items: ResponsesInputItem[]): void {
    if (typeof msg.content === 'string') {
      items.push({
        role: 'user',
        type: 'message',
        content: [{ type: 'input_text', text: msg.content }],
      })
      return
    }

    const contentParts: ResponsesInputContent[] = []
    const toolResults: Array<{ tool_use_id: string; content: string }> = []

    for (const block of normalizeContentBlocks(msg.content)) {
      if (block.type === 'text') {
        contentParts.push({ type: 'input_text', text: block.text })
      } else if (block.type === 'image') {
        const url = imageSourceToUrl(block.source)
        if (url) {
          contentParts.push({ type: 'input_image', image_url: url })
        }
      } else if (block.type === 'tool_result') {
        toolResults.push({
          tool_use_id: block.tool_use_id,
          content: block.content,
        })
      }
    }

    // Tool results become function_call_output items
    for (const tr of toolResults) {
      items.push({
        type: 'function_call_output',
        call_id: tr.tool_use_id,
        output: tr.content,
      })
    }

    // Text/image parts become a user message
    if (contentParts.length > 0) {
      items.push({
        role: 'user',
        type: 'message',
        content: contentParts,
      })
    }
  }

  private convertAssistantMessage(msg: NormalizedMessageParam, items: ResponsesInputItem[]): void {
    if (typeof msg.content === 'string') {
      // Responses API assistant messages use 'message' type items
      // but previous_response_id is the preferred way to handle multi-turn.
      // For now, we add them as input items.
      items.push({
        role: 'developer' as any, // Responses API doesn't have assistant input role
        type: 'message',
        content: [{ type: 'input_text', text: msg.content }],
      } as any)
      return
    }

    const textParts: string[] = []

    for (const block of normalizeContentBlocks(msg.content)) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        items.push({
          type: 'function_call',
          id: block.id,
          call_id: block.id,
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        })
      }
    }

    if (textParts.length > 0) {
      items.push({
        role: 'developer' as any,
        type: 'message',
        content: [{ type: 'input_text', text: textParts.join('\n') }],
      } as any)
    }
  }

  private convertTools(tools: NormalizedTool[]): ResponsesFunctionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    }))
  }

  // --------------------------------------------------------------------------
  // Response conversion
  // --------------------------------------------------------------------------

  private convertResponse(data: ResponsesApiResponse): CreateMessageResponse {
    const content: NormalizedResponseBlock[] = []

    if (data.error) {
      return {
        content: [{ type: 'text', text: `Error: ${data.error.message}` }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    }

    for (const item of data.output ?? []) {
      if (item.type === 'message' && item.role === 'assistant') {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) {
            content.push({ type: 'text', text: c.text })
          }
        }
      } else if (item.type === 'function_call') {
        let input: any
        try {
          input = JSON.parse(item.arguments)
        } catch {
          input = item.arguments
        }
        content.push({
          type: 'tool_use',
          id: item.call_id || item.id,
          name: item.name,
          input,
        })
      }
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    const hasToolCalls = data.output?.some((item) => item.type === 'function_call') ?? false
    const stopReason = data.status === 'incomplete' ? 'max_tokens'
      : hasToolCalls ? 'tool_use'
      : 'end_turn'

    return {
      content,
      stopReason,
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  }

  // --------------------------------------------------------------------------
  // HTTP
  // --------------------------------------------------------------------------

  private async fetchResponse(body: Record<string, unknown>): Promise<Response> {
    return withRetry(async () => {
      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        const err: any = new Error(
          `OpenAI Responses API error: ${response.status} ${response.statusText}: ${errBody}`,
        )
        err.status = response.status
        throw err
      }

      return response
    }, this.retryConfig)
  }
}
```

- [ ] **Step 2: 编写 Provider 单元测试**

创建 `packages/sdk/src/providers/openai-responses.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAIResponsesProvider } from './openai-responses.js'

describe('OpenAIResponsesProvider', () => {
  let provider: OpenAIResponsesProvider

  beforeEach(() => {
    provider = new OpenAIResponsesProvider({
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
    })
  })

  it('should have apiType openai-responses', () => {
    expect(provider.apiType).toBe('openai-responses')
  })

  describe('createMessage (non-streaming)', () => {
    it('should send request to /responses endpoint', async () => {
      const mockResponse = {
        id: 'resp_123',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello World' }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response)

      const result = await provider.createMessage({
        model: 'gpt-4o',
        maxTokens: 1024,
        system: 'You are helpful',
        messages: [
          { role: 'user', content: 'Hello' },
        ],
      })

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/responses',
        expect.objectContaining({ method: 'POST' }),
      )

      const body = JSON.parse((fetchSpy.mock.calls[0] as any[])[1].body)
      expect(body.input).toBeDefined()
      expect(body.instructions).toBe('You are helpful')
      expect(body.model).toBe('gpt-4o')
      expect(body.max_output_tokens).toBe(1024)

      expect(result.content).toEqual([
        { type: 'text', text: 'Hello World' },
      ])
      expect(result.stopReason).toBe('end_turn')
      expect(result.usage.input_tokens).toBe(10)
      expect(result.usage.output_tokens).toBe(5)

      fetchSpy.mockRestore()
    })

    it('should handle function calls in response', async () => {
      const mockResponse = {
        id: 'resp_456',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id: 'fc_001',
            call_id: 'call_001',
            name: 'get_weather',
            arguments: '{"location":"Tokyo"}',
            status: 'completed',
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      }

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response)

      const result = await provider.createMessage({
        model: 'gpt-4o',
        maxTokens: 1024,
        system: '',
        messages: [{ role: 'user', content: 'What is the weather?' }],
      })

      expect(result.content).toEqual([
        {
          type: 'tool_use',
          id: 'call_001',
          name: 'get_weather',
          input: { location: 'Tokyo' },
        },
      ])
      expect(result.stopReason).toBe('tool_use')
    })

    it('should convert tool_result to function_call_output', async () => {
      const mockResponse = {
        id: 'resp_789',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The weather is sunny' }],
          },
        ],
        usage: { input_tokens: 30, output_tokens: 15, total_tokens: 45 },
      }

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response)

      await provider.createMessage({
        model: 'gpt-4o',
        maxTokens: 1024,
        system: '',
        messages: [
          { role: 'user', content: 'Weather?' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_001', name: 'get_weather', input: { location: 'Tokyo' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_001', content: 'Sunny, 25°C' }],
          },
        ],
      })

      const body = JSON.parse((fetchSpy.mock.calls[0] as any[])[1].body)
      const functionCallOutput = body.input.find((item: any) => item.type === 'function_call_output')
      expect(functionCallOutput).toEqual({
        type: 'function_call_output',
        call_id: 'call_001',
        output: 'Sunny, 25°C',
      })

      fetchSpy.mockRestore()
    })
  })
})
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cd packages/sdk && npx vitest run src/providers/openai-responses.test.ts`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/providers/openai-responses.ts packages/sdk/src/providers/openai-responses.test.ts
git commit -m "feat(sdk): add OpenAIResponsesProvider for /v1/responses API"
```

---

### Task 4: SDK 工厂注册 — 注册新 Provider

**Files:**
- Modify: `packages/sdk/src/providers/index.ts`

- [ ] **Step 1: 注册 OpenAIResponsesProvider**

在 `packages/sdk/src/providers/index.ts` 中：

1. 添加 export：
```typescript
export { OpenAIResponsesProvider } from './openai-responses.js'
```

2. 添加 import：
```typescript
import { OpenAIResponsesProvider } from './openai-responses.js'
```

3. 在 `createProvider` 的 switch 中添加分支：
```typescript
case 'openai-responses':
  return new OpenAIResponsesProvider(opts)
```

- [ ] **Step 2: 验证编译和测试**

Run: `cd packages/sdk && npx vitest run src/providers/ 2>&1 | tail -20`
Expected: 所有测试通过

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/providers/index.ts
git commit -m "feat(sdk): register OpenAIResponsesProvider in factory"
```

---

### Task 5: SDK Agent — 自动检测 Responses API 模式

**Files:**
- Modify: `packages/sdk/src/agent.ts` (`resolveApiType` 方法，约 297-350 行)

- [ ] **Step 1: 更新 resolveApiType 方法**

在 `resolveApiType` 方法中，在 `if (baseUrl)` 块内添加对 Responses API 的检测：

在现有 `if (baseUrl.includes('/chat/completions'))` 之后添加：
```typescript
if (baseUrl.includes('/responses')) {
  return 'openai-responses'
}
```

在 model 检测块中（约 331 行），`if (model.includes('gpt-')` 之前添加：
```typescript
if (model.includes('responses') || this.cfg.apiType === 'openai-responses') {
  return 'openai-responses'
}
```

- [ ] **Step 2: 验证编译通过**

Run: `cd packages/sdk && npx tsc --noEmit 2>&1 | head -10`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/agent.ts
git commit -m "feat(sdk): auto-detect openai-responses ApiType from URL/model"
```

---

### Task 6: Sidecar Adapter — OpenAIResponsesAdapter 实现

**Files:**
- Create: `apps/sidecar/src/providers/openai-responses-adapter.ts`
- Create: `apps/sidecar/src/providers/openai-responses-adapter.test.ts`

- [ ] **Step 1: 编写 Adapter 实现**

创建 `apps/sidecar/src/providers/openai-responses-adapter.ts`：

```typescript
/**
 * OpenAI Responses API 适配器
 *
 * 实现 OpenAI Responses API (/v1/responses) 的消息转换、请求构建和 SSE 解析。
 * 与 OpenAIAdapter 并行存在，通过 Channel.openaiApiMode 字段选择使用哪个。
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  StreamRequestInput,
  StreamEvent,
  TitleRequestInput,
  ImageAttachmentData,
  ToolDefinition,
  ContinuationMessage,
} from './types'
import { normalizeBaseUrl } from './url-utils'

// ===== Responses API 类型 =====

interface ResponsesInputItem {
  type?: 'message' | 'function_call' | 'function_call_output'
  role?: 'user' | 'developer'
  content?: ResponsesInputContent[]
  call_id?: string
  name?: string
  arguments?: string
  output?: string
  id?: string
}

type ResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }

interface ResponsesStreamEvent {
  type: string
  delta?: string
  output_index?: number
  content_index?: number
  item?: {
    type: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
    status?: string
  }
}

// ===== 消息转换 =====

function buildInputContent(
  text: string,
  imageData: ImageAttachmentData[],
): ResponsesInputContent[] {
  const parts: ResponsesInputContent[] = []
  for (const img of imageData) {
    parts.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.data}` })
  }
  if (text) {
    parts.push({ type: 'input_text', text })
  }
  return parts
}

function toResponsesInput(input: StreamRequestInput): ResponsesInputItem[] {
  const { history, userMessage, attachments, readImageAttachments } = input
  const items: ResponsesInputItem[] = []

  for (const msg of history) {
    if (msg.role === 'system') continue

    if (msg.role === 'user') {
      if (msg.attachments && msg.attachments.length > 0) {
        const images = readImageAttachments(msg.attachments)
        items.push({
          type: 'message',
          role: 'user',
          content: buildInputContent(msg.content, images),
        })
      } else {
        items.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: msg.content }],
        })
      }
    } else if (msg.role === 'assistant') {
      // Assistant history: just text for context
      items.push({
        type: 'message',
        role: 'developer' as any,
        content: [{ type: 'input_text', text: msg.content }],
      } as any)
    }
  }

  // Current user message
  const currentImages = readImageAttachments(attachments)
  items.push({
    type: 'message',
    role: 'user',
    content: buildInputContent(userMessage, currentImages),
  })

  return items
}

function appendResponsesContinuation(
  items: ResponsesInputItem[],
  continuationMessages: ContinuationMessage[],
): void {
  for (const msg of continuationMessages) {
    if (msg.role === 'assistant') {
      // Assistant tool calls → function_call items
      for (const tc of msg.toolCalls) {
        items.push({
          type: 'function_call',
          id: tc.id,
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        })
      }
      // Assistant text content
      if (msg.content) {
        items.push({
          type: 'message',
          role: 'developer' as any,
          content: [{ type: 'input_text', text: msg.content }],
        } as any)
      }
    } else if (msg.role === 'tool') {
      for (const result of msg.results) {
        items.push({
          type: 'function_call_output',
          call_id: result.toolCallId,
          output: result.content,
        })
      }
    }
  }
}

function toResponsesTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

// ===== 适配器实现 =====

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly providerType: ProviderAdapter['providerType'] = 'openai'

  buildStreamRequest(input: StreamRequestInput): ProviderRequest {
    const url = normalizeBaseUrl(input.baseUrl)
    const inputItems = toResponsesInput(input)
    const bodyObj: Record<string, unknown> = {
      model: input.modelId,
      input: inputItems,
      stream: true,
    }

    if (input.systemMessage) {
      bodyObj.instructions = input.systemMessage
    }

    if (input.tools && input.tools.length > 0) {
      bodyObj.tools = toResponsesTools(input.tools)
    }

    if (input.continuationMessages && input.continuationMessages.length > 0) {
      appendResponsesContinuation(inputItems, input.continuationMessages)
    }

    return {
      url: `${url}/responses`,
      headers: {
        'Authorization': `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(bodyObj),
    }
  }

  parseSSELine(jsonLine: string): StreamEvent[] {
    try {
      const event = JSON.parse(jsonLine) as ResponsesStreamEvent
      const events: StreamEvent[] = []

      switch (event.type) {
        case 'response.output_text.delta': {
          if (event.delta) {
            events.push({ type: 'chunk', delta: event.delta })
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          if (event.delta) {
            events.push({
              type: 'tool_call_delta',
              toolCallId: `fc_${event.output_index ?? 0}`,
              argumentsDelta: event.delta,
            })
          }
          break
        }
        case 'response.output_item.added': {
          const item = event.item
          if (item && item.type === 'function_call') {
            events.push({
              type: 'tool_call_start',
              toolCallId: item.call_id || item.id || `fc_${event.output_index ?? 0}`,
              toolName: item.name || '',
            })
          }
          break
        }
        case 'response.completed': {
          // 检查是否有 function_call 输出
          const resp = (event as any).response
          const hasToolCalls = resp?.output?.some?.((o: any) => o.type === 'function_call') ?? false
          events.push({
            type: 'done',
            stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
          })
          break
        }
      }

      return events
    } catch {
      return []
    }
  }

  buildTitleRequest(input: TitleRequestInput): ProviderRequest {
    const url = normalizeBaseUrl(input.baseUrl)

    return {
      url: `${url}/responses`,
      headers: {
        'Authorization': `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.modelId,
        input: [{ role: 'user', type: 'message', content: [{ type: 'input_text', text: input.prompt }] }],
        max_output_tokens: 50,
      }),
    }
  }

  parseTitleResponse(responseBody: unknown): string | null {
    const data = responseBody as {
      output?: Array<{
        type: string
        content?: Array<{ type: string; text?: string }>
      }>
    }

    if (!data.output) return null

    for (const item of data.output) {
      if (item.type === 'message' && item.content) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) {
            return c.text
          }
        }
      }
    }

    return null
  }
}
```

- [ ] **Step 2: 编写 Adapter 单元测试**

创建 `apps/sidecar/src/providers/openai-responses-adapter.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { OpenAIResponsesAdapter } from './openai-responses-adapter'

describe('OpenAIResponsesAdapter', () => {
  const adapter = new OpenAIResponsesAdapter()

  const mockInput = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    modelId: 'gpt-4o',
    history: [],
    userMessage: 'Hello',
    systemMessage: 'You are helpful',
    attachments: [],
    readImageAttachments: () => [],
  }

  describe('buildStreamRequest', () => {
    it('should target /responses endpoint', () => {
      const request = adapter.buildStreamRequest(mockInput)
      expect(request.url).toBe('https://api.openai.com/v1/responses')
    })

    it('should use instructions field for system message', () => {
      const request = adapter.buildStreamRequest(mockInput)
      const body = JSON.parse(request.body)
      expect(body.instructions).toBe('You are helpful')
    })

    it('should use input array instead of messages', () => {
      const request = adapter.buildStreamRequest(mockInput)
      const body = JSON.parse(request.body)
      expect(body.input).toBeDefined()
      expect(body.messages).toBeUndefined()
    })

    it('should include Bearer auth header', () => {
      const request = adapter.buildStreamRequest(mockInput)
      expect(request.headers['Authorization']).toBe('Bearer test-key')
    })
  })

  describe('parseSSELine', () => {
    it('should parse response.output_text.delta events', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'Hello',
        output_index: 0,
        content_index: 0,
      }))

      expect(events).toEqual([
        { type: 'chunk', delta: 'Hello' },
      ])
    })

    it('should parse response.function_call_arguments.delta events', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.function_call_arguments.delta',
        delta: '{"location":',
        output_index: 1,
      }))

      expect(events).toEqual([
        { type: 'tool_call_delta', toolCallId: 'fc_1', argumentsDelta: '{"location":' },
      ])
    })

    it('should parse response.output_item.added for function calls', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_001',
          call_id: 'call_001',
          name: 'get_weather',
          arguments: '',
          status: 'in_progress',
        },
      }))

      expect(events).toEqual([
        { type: 'tool_call_start', toolCallId: 'call_001', toolName: 'get_weather' },
      ])
    })

    it('should parse response.completed event', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.completed',
        response: {
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
          ],
        },
      }))

      expect(events).toEqual([
        { type: 'done', stopReason: 'end_turn' },
      ])
    })

    it('should return empty array for unknown event types', () => {
      const events = adapter.parseSSELine(JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_123' },
      }))

      expect(events).toEqual([])
    })

    it('should handle malformed JSON gracefully', () => {
      const events = adapter.parseSSELine('not valid json')
      expect(events).toEqual([])
    })
  })

  describe('buildTitleRequest', () => {
    it('should target /responses endpoint', () => {
      const request = adapter.buildTitleRequest({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'key',
        modelId: 'gpt-4o-mini',
        prompt: 'Generate a title',
      })

      expect(request.url).toBe('https://api.openai.com/v1/responses')
      const body = JSON.parse(request.body)
      expect(body.input[0].content[0].text).toContain('Generate a title')
    })
  })

  describe('parseTitleResponse', () => {
    it('should extract text from output', () => {
      const title = adapter.parseTitleResponse({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'My Chat Title' }],
          },
        ],
      })

      expect(title).toBe('My Chat Title')
    })

    it('should return null for empty output', () => {
      expect(adapter.parseTitleResponse({ output: [] })).toBeNull()
      expect(adapter.parseTitleResponse({})).toBeNull()
    })
  })
})
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cd apps/sidecar && npx vitest run src/providers/openai-responses-adapter.test.ts`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/providers/openai-responses-adapter.ts apps/sidecar/src/providers/openai-responses-adapter.test.ts
git commit -m "feat(sidecar): add OpenAIResponsesAdapter for /v1/responses API"
```

---

### Task 7: Sidecar 注册 — 注册新 Adapter 并修改选择逻辑

**Files:**
- Modify: `apps/sidecar/src/providers/index.ts`
- Modify: `apps/sidecar/src/services/channel/model-selection.ts`

- [ ] **Step 1: 导出 OpenAIResponsesAdapter**

在 `apps/sidecar/src/providers/index.ts` 中：

1. 添加 import：
```typescript
import { OpenAIResponsesAdapter } from './openai-responses-adapter'
```

2. 添加 export：
```typescript
export { OpenAIResponsesAdapter } from './openai-responses-adapter'
```

- [ ] **Step 2: 修改 getAdapter 支持 Responses API 模式**

在 `apps/sidecar/src/providers/index.ts` 中，修改 `getAdapter` 函数签名和实现：

```typescript
/**
 * 根据供应商类型获取适配器
 *
 * @param provider 供应商类型
 * @param openaiApiMode OpenAI API 模式（仅 provider='openai' 时使用）
 */
export function getAdapter(provider: ProviderType, openaiApiMode?: 'chat-completions' | 'responses'): ProviderAdapter {
  if (provider === 'openai' && openaiApiMode === 'responses') {
    const adapter = adapterRegistry.get('openai-responses')
    if (adapter) return adapter
  }
  const adapter = adapterRegistry.get(provider)
  if (!adapter) {
    throw new Error(`不支持的供应商: ${provider}`)
  }
  return adapter
}
```

在 `adapterRegistry` 中添加注册：

```typescript
['openai-responses', new OpenAIResponsesAdapter()],
```

注意：这里用 `'openai-responses'` 作为注册表的 key，但 `ProviderType` 中不包含这个值，所以需要类型断言或使用 string 作为 Map 的 key 类型。更好的做法是直接实例化而不注册到 Map，修改如下：

```typescript
// 保持 adapterRegistry 不变，改为在 getAdapter 中按需创建
const responsesAdapter = new OpenAIResponsesAdapter()

export function getAdapter(provider: ProviderType, openaiApiMode?: 'chat-completions' | 'responses'): ProviderAdapter {
  if (provider === 'openai' && openaiApiMode === 'responses') {
    return responsesAdapter
  }
  const adapter = adapterRegistry.get(provider)
  if (!adapter) {
    throw new Error(`不支持的供应商: ${provider}`)
  }
  return adapter
}
```

- [ ] **Step 3: 更新 model-selection 传递 openaiApiMode**

在 `apps/sidecar/src/services/channel/model-selection.ts` 中：

1. 在 `resolveChannelModelSelection` 的返回类型中添加 `openaiApiMode`：

```typescript
export function resolveChannelModelSelection(input: {
  channelProvider: ProviderType;
  baseUrl: string;
  modelId: string;
  apiFamily?: string;
  openaiApiMode?: 'chat-completions' | 'responses';
}): {
  adapterProvider: ProviderType;
  resolvedModelId: string;
  modelRef: string;
  openaiApiMode?: 'chat-completions' | 'responses';
} {
```

2. 在返回值中透传 `openaiApiMode`：

```typescript
  return {
    adapterProvider,
    resolvedModelId: parsed.model,
    modelRef: `${parsed.provider}/${parsed.model}`,
    openaiApiMode: input.openaiApiMode,
  }
```

- [ ] **Step 4: 更新 agent-service 调用点**

在 `apps/sidecar/src/services/agent/agent-service.ts` 中，查找所有 `getAdapter()` 调用，传递 `openaiApiMode`：

标题生成处（约 1006 行）：
```typescript
const modelSelection = resolveChannelModelSelection({
  channelProvider: channel.provider,
  baseUrl: channel.baseUrl,
  modelId: boundModel?.modelId ?? input.modelId,
  openaiApiMode: channel.openaiApiMode,
})
const adapter = getAdapter(modelSelection.adapterProvider, modelSelection.openaiApiMode)
```

- [ ] **Step 5: 运行所有相关测试**

Run: `cd apps/sidecar && npx vitest run src/providers/ 2>&1 | tail -20`
Expected: 所有测试通过

- [ ] **Step 6: Commit**

```bash
git add apps/sidecar/src/providers/index.ts apps/sidecar/src/services/channel/model-selection.ts apps/sidecar/src/services/agent/agent-service.ts
git commit -m "feat(sidecar): register OpenAIResponsesAdapter and pass openaiApiMode through selection"
```

---

### Task 8: 集成验证 — 编译和端到端检查

**Files:**
- 无新文件，全量编译验证

- [ ] **Step 1: 全量 TypeScript 编译检查**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/sdk/tsconfig.json && npx tsc --noEmit -p apps/sidecar/tsconfig.json`
Expected: 无错误

- [ ] **Step 2: 运行所有 Provider 相关测试**

Run: `cd packages/sdk && npx vitest run src/providers/ && cd ../../apps/sidecar && npx vitest run src/providers/`
Expected: 所有测试通过

- [ ] **Step 3: 验证现有功能不受影响**

Run: `cd packages/sdk && npx vitest run 2>&1 | tail -10`
Expected: 所有测试通过，无回归

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: address integration issues from Responses API adaptation"
```

---

## 自检清单

### 1. 规格覆盖

- [x] Responses API 端点 (`/v1/responses`) — Task 3, Task 6
- [x] 请求格式转换 (`input` + `instructions`) — Task 3, Task 6
- [x] 响应格式解析 (`output` 数组) — Task 3, Task 6
- [x] 流式事件解析 (typed SSE events) — Task 3, Task 6
- [x] 工具调用 (function_call / function_call_output) — Task 3, Task 6
- [x] 图片输入 (input_image) — Task 3, Task 6
- [x] SDK 层 Provider — Task 3, Task 4
- [x] Sidecar 层 Adapter — Task 6, Task 7
- [x] 自动 API 类型检测 — Task 5
- [x] 用户可配置 (openaiApiMode) — Task 2, Task 7

### 2. 占位符扫描

无 TBD、TODO、placeholder。所有代码步骤均包含完整实现。

### 3. 类型一致性

- `OpenAIResponsesProvider.apiType` = `'openai-responses'` — 与 `ApiType` 一致
- `OpenAIResponsesAdapter.providerType` = `'openai'` — 与 ProviderType 一致
- `getAdapter(provider, openaiApiMode)` — 参数类型一致
- `resolveChannelModelSelection` 返回值包含 `openaiApiMode` — 与调用点一致
