/**
 * Token Estimation & Counting
 *
 * Provides rough token estimation (character-based) and native counting when
 * available. Native counts are exact for inputs ≤8KB; larger inputs are
 * counted in chunks (see countTokensNativeChunked) and become close
 * approximations — consumed only by thresholds/display, never billing.
 */

import { countStringTokens } from '@lume/natives'
import { findModelMeta, type ModelPricing } from '@lume/shared'

/**
 * 按消息对象引用缓存 token 计数。依赖消息不可变（追加 / 整体替换，非原地改内容）：
 * 追加的消息计数一次后命中；compaction 替换数组后旧对象不可达，条目随 WeakMap GC；
 * 编辑/重试产生新对象 → 自动重算。跨 session 安全（不同对象）。
 */
let messageTokenCache = new WeakMap<object, number>()

/**
 * Rough token estimation.
 *
 * Prefers native tiktoken counting (exact ≤8KB; chunked approximation for
 * larger inputs, see countTokensNativeChunked). Falls back to a character
 * heuristic when natives are unavailable: ASCII-heavy text is roughly
 * 4 chars/token, while CJK and emoji-like codepoints are closer to 1
 * char/token — keeps live context estimates from badly undercounting
 * Chinese/Japanese/Korean prompts.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  try {
    const nativeCount = countTokensNativeChunked(text)
    if (nativeCount > 0) return nativeCount
  } catch {
    // Keep @lume/agent-sdk usable without native binaries.
  }
  let asciiChars = 0
  let fullTokenChars = 0

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (countsAsFullTokenChar(code)) {
      fullTokenChars += 1
    } else {
      asciiChars += 1
    }
  }

  return fullTokenChars + Math.ceil(asciiChars / 4)
}

/**
 * 原生计数入口的分块保护（#736）：tiktoken 对「单 regex piece 内无换行的长
 * 游程」近 O(n²)（256KB≈30s，Read 的 1MiB 上限外推 ~10min 同步冻结）。按
 * 换行切块、单块超限再定长硬切；块内二次分量使总成本 ∝ N×LIMIT——8KB 时
 * 1MiB 单行实测从 ~10min 冻结降到 ~2.4s（napi 单调用开销仅 ~1.5µs，调小近乎免费）。
 * 近似口径（#738 review 实测）：跨块边界丢失 BPE 合并致恒保守多计——多行
 * 散文 +0~3%（每边界 ≤1）、空白密集 markdown 实测 ~+6%，极端纯换行串因
 * 逐分隔符成块可放大一个数量级（16× 实测）；方向恒保守多计。本
 * 计数只服务阈值/展示估算，保守方向无资源越界风险。
 */
const TOKEN_NATIVE_PIECE_LIMIT = 8 * 1024

function countTokensNativeChunked(text: string): number {
  if (text.length <= TOKEN_NATIVE_PIECE_LIMIT) {
    return countStringTokens(text)
  }
  let total = 0
  let start = 0
  while (start < text.length) {
    // 切块边界落在换行之后：分隔符计入前块，多行文本的计数不因切块丢失
    let boundary = text.indexOf("\n", start)
    boundary = boundary === -1 ? text.length : boundary + 1
    while (start < boundary) {
      const stop = Math.min(start + TOKEN_NATIVE_PIECE_LIMIT, boundary)
      total += countStringTokens(text.slice(start, stop))
      start = stop
    }
  }
  return total
}

/**
 * Estimate tokens for a message array.
 */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content?: any }>,
): number {
  let total = 0
  for (const msg of messages) {
    const cached = messageTokenCache.get(msg)
    if (cached !== undefined) {
      total += cached
      continue
    }
    const count = estimateContentTokens(msg.content)
    messageTokenCache.set(msg, count)
    total += count
  }
  return total
}

/** 测试专用：清空消息 token 缓存。生产代码勿调用。 */
export function __resetMessageTokenCacheForTests(): void {
  messageTokenCache = new WeakMap()
}

const IMAGE_OR_DOCUMENT_TOKEN_ESTIMATE = 2_000

function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content)
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + estimateContentBlockTokens(block), 0)
  }
  if (content === null || content === undefined) return 0
  return estimateTokens(safeStringify(content))
}

function estimateContentBlockTokens(block: unknown): number {
  if (typeof block === 'string') return estimateTokens(block)
  if (!block || typeof block !== 'object') return 0
  const record = block as Record<string, unknown>

  if (record.type === 'text' && typeof record.text === 'string') {
    return estimateTokens(record.text)
  }
  if (record.type === 'thinking' && typeof record.thinking === 'string') {
    return estimateTokens(record.thinking)
  }
  if (record.type === 'redacted_thinking' && typeof record.data === 'string') {
    return estimateTokens(record.data)
  }
  if (record.type === 'image' || record.type === 'document') {
    return IMAGE_OR_DOCUMENT_TOKEN_ESTIMATE
  }
  if (record.type === 'tool_result') {
    return estimateContentTokens(record.content)
  }
  if (record.type === 'tool_use') {
    return estimateTokens(`${String(record.name ?? '')}${safeStringify(record.input ?? {})}`)
  }
  if (typeof record.text === 'string') {
    return estimateTokens(record.text)
  }
  if ('content' in record) {
    return estimateContentTokens(record.content)
  }
  return estimateTokens(safeStringify(record))
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function countsAsFullTokenChar(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af)
    || code >= 0x1f300
  )
}

/**
 * Estimate tokens for a system prompt.
 */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  return estimateTokens(systemPrompt)
}

/**
 * Get the context window size for a model.
 */
/** 单一回落的上下文窗口缺省值（#567 第 3 项）：目录缺失时引擎阈值/provider 元数据/
 *  kernel 控制器全部以此对齐，禁止各层私设回落。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

export function getContextWindowSize(model: string): number {
  // Anthropic model context windows
  if (model.includes('opus-4') && model.includes('1m')) return 1_000_000
  if (model.includes('opus-4')) return 200_000
  if (model.includes('sonnet-4')) return 200_000
  if (model.includes('haiku-4')) return 200_000
  if (model.includes('claude-3')) return 200_000

  // OpenAI model context windows
  if (model.includes('gpt-4o')) return 128_000
  if (model.includes('gpt-4-turbo')) return 128_000
  if (model.includes('gpt-4.1') || model.includes('gpt-4-1')) return 1_000_000
  if (model.includes('gpt-4')) return 128_000
  if (model.includes('gpt-3.5')) return 16_385
  if (model.includes('o1')) return 200_000
  if (model.includes('o3')) return 200_000
  if (model.includes('o4')) return 200_000

  // DeepSeek models
  if (model.includes('deepseek')) return 128_000

  // Fall back to the shared model registry so catalogued models with windows
  // outside the table above (e.g. gemini/qwen 1M) resolve correctly (#366).
  const meta = findModelMeta(model)
  if (meta?.contextWindow && meta.contextWindow > 0) return meta.contextWindow

  // Default
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Model pricing (USD per token).
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic models
  'claude-opus-4-6': { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  'claude-opus-4-5': { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  'claude-sonnet-4-6': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-sonnet-4-5': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-haiku-4-5': { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  'claude-3-5-sonnet': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-3-5-haiku': { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  'claude-3-opus': { input: 15 / 1_000_000, output: 75 / 1_000_000 },

  // OpenAI models
  'gpt-4o': { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  'gpt-4-turbo': { input: 10 / 1_000_000, output: 30 / 1_000_000 },
  'gpt-4.1': { input: 2 / 1_000_000, output: 8 / 1_000_000 },
  'o1': { input: 15 / 1_000_000, output: 60 / 1_000_000 },
  'o3': { input: 10 / 1_000_000, output: 40 / 1_000_000 },
  'o4-mini': { input: 1.1 / 1_000_000, output: 4.4 / 1_000_000 },

  // DeepSeek models
  'deepseek-chat': { input: 0.27 / 1_000_000, output: 1.1 / 1_000_000 },
  'deepseek-reasoner': { input: 0.55 / 1_000_000, output: 2.19 / 1_000_000 },
}

/**
 * Estimate cost from usage and model.
 */
// Longest-key-first: `find` in insertion order made 'gpt-4o-mini' match 'gpt-4o'
const PRICING_ENTRIES = [...Object.entries(MODEL_PRICING)].sort(
  ([a], [b]) => b.length - a.length,
)

/** shared registry prices are USD per 1M tokens; MODEL_PRICING is per token */
function sharedPricingToPerToken(pricing: ModelPricing | undefined) {
  if (!pricing || pricing.input <= 0 || pricing.output <= 0) return undefined
  return { input: pricing.input / 1_000_000, output: pricing.output / 1_000_000 }
}

export function estimateCost(
  model: string,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
): number {
  const pricing =
    PRICING_ENTRIES.find(([key]) => model.includes(key))?.[1] ??
    sharedPricingToPerToken(findModelMeta(model)?.pricing) ?? {
      // rough estimate fallback — the costUSD contract requires a number
      input: 3 / 1_000_000,
      output: 15 / 1_000_000,
    }

  // Cache reads bill at ~10% of the input price, cache writes at a 25% premium;
  // ignoring them understated totalCost and let maxBudgetUsd trip too late.
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  return (
    usage.input_tokens * pricing.input
    + usage.output_tokens * pricing.output
    + cacheRead * pricing.input * 0.1
    + cacheWrite * pricing.input * 1.25
  )
}
