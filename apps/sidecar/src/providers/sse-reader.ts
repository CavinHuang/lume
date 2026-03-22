/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\packages\core\src\providers\sse-reader.ts
 * Adaptation:
 * - Kept logic parity for MIG-003.
 */

/**
 * 共享 SSE 流式读取器
 *
 * 封装所有供应商通用的 SSE 解析逻辑：
 * - fetch 调用 + 错误检查
 * - ReadableStream reader + TextDecoder 管理
 * - 逐行 buffer 分割 + data: 前缀检测 + [DONE] 哨兵处理
 * - 通过 adapter.parseSSELine() 委托供应商特定解析
 * - 通过回调分发事件
 */

import type { ProviderAdapter, ProviderRequest, StreamEventCallback, ToolCall } from './types'

// ===== 流式请求 =====

/** streamSSE 的输入选项 */
export interface StreamSSEOptions {
  /** 构建好的 HTTP 请求配置 */
  request: ProviderRequest
  /** 供应商适配器（用于解析 SSE 行） */
  adapter: ProviderAdapter
  /** 事件回调 */
  onEvent: StreamEventCallback
  /** AbortSignal 用于取消请求 */
  signal?: AbortSignal
  /** 自定义 fetch 函数（代理等场景下由调用方注入） */
  fetchFn?: typeof globalThis.fetch
}

/** streamSSE 的返回结果 */
export interface StreamSSEResult {
  /** 累积的完整文本内容 */
  content: string
  /** 累积的推理内容 */
  reasoning: string
  /** 本轮返回的工具调用列表 */
  toolCalls: ToolCall[]
  /** 停止原因（'tool_use' 表示需要执行工具后继续） */
  stopReason?: string
}

/**
 * 执行流式 SSE 请求
 *
 * 通用流程：
 * 1. 发起 fetch POST 请求
 * 2. 检查响应状态
 * 3. 获取 ReadableStream reader，逐 chunk 读取
 * 4. 按换行分行，过滤 "data: " 前缀和 "[DONE]" 哨兵
 * 5. 调用 adapter.parseSSELine() 解析供应商特定 JSON
 * 6. 累积 content/reasoning，通过 onEvent 回调分发
 * 7. 返回完整内容
 */
export async function streamSSE(options: StreamSSEOptions): Promise<StreamSSEResult> {
  const { request, adapter, onEvent, signal, fetchFn = fetch } = options

  // 1. 发起请求
  const response = await fetchFn(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal,
  })

  // 2. 错误检查
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${adapter.providerType} API 错误 (${response.status}): ${text.slice(0, 300)}`)
  }

  if (!response.body) {
    throw new Error('响应体为空')
  }

  // 3. 读取流
  let content = ''
  let reasoning = ''
  let stopReason: string | undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pendingToolCalls = new Map<string, { id: string; name: string; args: string; metadata?: Record<string, unknown> }>()
  const toolCallIdAlias = new Map<string, string>()
  const toolCallIdByBlockIndex = new Map<number, string>()
  const preStartArgsBuffer = new Map<string, string>()
  const preStartArgsByBlockIndex = new Map<number, string>()
  let anonymousArgsBuffer = ''
  let currentToolCallId: string | undefined

  function allocateUniqueToolCallId(rawId: string): string {
    if (!pendingToolCalls.has(rawId)) return rawId
    let counter = 2
    let nextId = `${rawId}__${counter}`
    while (pendingToolCalls.has(nextId)) {
      counter += 1
      nextId = `${rawId}__${counter}`
    }
    return nextId
  }

  function getBlockIndex(metadata?: Record<string, unknown>): number | undefined {
    const candidate = metadata?.blockIndex
    return typeof candidate === 'number' ? candidate : undefined
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 保留最后一个可能不完整的行
      buffer = lines.pop() || ''

      for (const line of lines) {
        let data: string
        if (line.startsWith('data: ')) {
          data = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          data = line.slice(5).trim()
        } else {
          continue
        }
        if (data === '[DONE]' || !data) continue

        // 4. 委托给 adapter 解析供应商特定 JSON
        const events = adapter.parseSSELine(data)

        for (const event of events) {
          if (event.type === 'chunk') {
            content += event.delta
          } else if (event.type === 'reasoning') {
            reasoning += event.delta
          } else if (event.type === 'tool_call_start') {
            const rawId = (event.toolCallId || '').trim() || `tc_${pendingToolCalls.size}`
            const normalizedId = allocateUniqueToolCallId(rawId)
            toolCallIdAlias.set(rawId, normalizedId)
            const blockIndex = getBlockIndex(event.metadata)
            if (typeof blockIndex === 'number') {
              toolCallIdByBlockIndex.set(blockIndex, normalizedId)
            }
            currentToolCallId = normalizedId
            const bufferedArgs = preStartArgsBuffer.get(rawId) || ''
            const bufferedArgsByIndex = typeof blockIndex === 'number'
              ? (preStartArgsByBlockIndex.get(blockIndex) || '')
              : ''
            const combinedBufferedArgs = `${bufferedArgs}${bufferedArgsByIndex}${anonymousArgsBuffer}`
            preStartArgsBuffer.delete(rawId)
            if (typeof blockIndex === 'number') {
              preStartArgsByBlockIndex.delete(blockIndex)
            }
            anonymousArgsBuffer = ''
            pendingToolCalls.set(normalizedId, {
              id: normalizedId,
              name: event.toolName,
              args: combinedBufferedArgs,
              metadata: event.metadata,
            })
          } else if (event.type === 'tool_call_delta') {
            const rawId = (event.toolCallId || '').trim()
            const blockIndex = getBlockIndex(event.metadata)
            const indexedToolCallId = typeof blockIndex === 'number'
              ? toolCallIdByBlockIndex.get(blockIndex)
              : undefined
            const tcId = rawId
              ? (toolCallIdAlias.get(rawId) || rawId)
              : (indexedToolCallId || currentToolCallId)
            if (tcId) {
              const pending = pendingToolCalls.get(tcId)
              if (pending) {
                pending.args += event.argumentsDelta
              } else if (rawId) {
                preStartArgsBuffer.set(rawId, (preStartArgsBuffer.get(rawId) || '') + event.argumentsDelta)
              } else if (typeof blockIndex === 'number') {
                preStartArgsByBlockIndex.set(
                  blockIndex,
                  (preStartArgsByBlockIndex.get(blockIndex) || '') + event.argumentsDelta
                )
              }
            } else if (typeof blockIndex === 'number') {
              preStartArgsByBlockIndex.set(
                blockIndex,
                (preStartArgsByBlockIndex.get(blockIndex) || '') + event.argumentsDelta
              )
            } else if (!rawId) {
              anonymousArgsBuffer += event.argumentsDelta
            }
          } else if (event.type === 'done' && event.stopReason) {
            stopReason = event.stopReason
          }
          onEvent(event)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  const toolCalls: ToolCall[] = []
  for (const [, pending] of pendingToolCalls) {
    toolCalls.push({
      id: pending.id,
      name: pending.name,
      arguments: parseToolArguments(pending.args),
      metadata: pending.metadata,
    })
  }

  if (toolCalls.length > 0 && !stopReason) {
    stopReason = 'tool_use'
  }

  onEvent({ type: 'done', stopReason })
  return { content, reasoning, toolCalls, stopReason }
}

function parseToolArguments(rawArgs: string): Record<string, unknown> {
  const trimmed = rawArgs.trim()
  if (!trimmed) return {}

  const candidates: string[] = []
  const seen = new Set<string>()
  const pushCandidate = (value: string): void => {
    const candidate = value.trim()
    if (!candidate || seen.has(candidate)) return
    seen.add(candidate)
    candidates.push(candidate)
  }

  pushCandidate(trimmed)

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch?.[1]) {
    pushCandidate(fenceMatch[1])
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    pushCandidate(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // ignore and continue trying other candidates
    }
  }

  return {}
}

// ===== 非流式标题请求 =====

/**
 * 执行非流式标题生成请求
 *
 * @param request 构建好的 HTTP 请求配置
 * @param adapter 供应商适配器（用于解析响应）
 * @returns 提取的标题文本，失败返回 null
 */
export async function fetchTitle(
  request: ProviderRequest,
  adapter: ProviderAdapter,
): Promise<string | null> {
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })

    if (!response.ok) return null

    const data: unknown = await response.json()
    return adapter.parseTitleResponse(data)
  } catch {
    return null
  }
}
