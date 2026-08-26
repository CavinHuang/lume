/**
 * Unified logging details shared by all processes.
 *
 * Key classification rules:
 * - REDACT_KEY_PARTS: credential-like keys → fully "[redacted]" (substring match, never logged).
 * - CONTENT_PREVIEW_KEYS: payload-like keys → truncated preview (first N chars), so
 *   "key action params/results" stay observable without leaking full bodies.
 */

import { LUME_LOG_LEVELS, LUME_LOG_SOURCES, type LumeLogLevel, type LumeLogSource } from "../types/logging";

export const LOG_PREVIEW_MAX_CHARS = 200

/** Substring fragments; a key whose normalized form CONTAINS any fragment is fully redacted. */
export const REDACT_KEY_PARTS: readonly string[] = [
  'token', 'secret', 'password', 'apikey', 'authorization',
  'cookie', 'setcookie', 'accesstoken', 'refreshtoken', 'grant',
]

/** Normalized key EXACTLY in this set → truncated preview instead of full redaction. */
export const CONTENT_PREVIEW_KEYS: ReadonlySet<string> = new Set([
  'body', 'prompt', 'systemprompt', 'rawrequest', 'rawresponse', 'requestbody', 'responsebody',
  'content', 'contents', 'html', 'markdown', 'input', 'output',
])

/** Union of both processes' quiet lists; failures are NEVER quiet regardless of this set. */
export const QUIET_RPC_METHODS: ReadonlySet<string> = new Set([
  'system.log-level',
  'healthcheck',
  'general-settings:get',
  'agent:list-threads',
  'agent:list-subagent-runs',
  'agent:get-pending-interactive',
  'agent:list-workspaces',
  'channel:oauth-status',
  'model-meta:get',
])

export type LogKeyClass = 'redact' | 'preview' | 'keep'

export function classifyLogKey(key: string): LogKeyClass {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '')
  if (REDACT_KEY_PARTS.some((part) => normalized.includes(part))) return 'redact'
  if (CONTENT_PREVIEW_KEYS.has(normalized)) return 'preview'
  return 'keep'
}

export function clipLogPreview(text: string): string {
  return text.length > LOG_PREVIEW_MAX_CHARS
    ? `${text.slice(0, LOG_PREVIEW_MAX_CHARS)}…(+${text.length - LOG_PREVIEW_MAX_CHARS})`
    : text
}

const SUMMARIZE_MAX_DEPTH = 2
const SUMMARIZE_MAX_KEYS = 30
// 键名同样要有上界：渲染层可控的超长键名曾实测把单条日志摘要撑到 30MB（fuzz 探针）。
const MAX_KEY_NAME_CHARS = 128

function clipKeyName(key: string): string {
  return key.length > MAX_KEY_NAME_CHARS ? `${key.slice(0, MAX_KEY_NAME_CHARS)}…` : key
}

/** 关联 ID 键 → 事件顶层字段名；值须通过 validId 同款形状校验才采纳。 */
const CORRELATION_ID_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['traceId', 'traceId'],
  ['runId', 'runId'],
  ['threadId', 'threadId'],
  ['sessionId', 'threadId'],
  ['submissionId', 'submissionId'],
  ['messageId', 'messageId'],
  ['rpcRequestId', 'rpcRequestId'],
]

function isValidIdShape(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value)
}

/**
 * 从载荷浅层（顶层与一层嵌套）提取已知关联 ID，供 IPC/RPC 摘要事件挂到顶层，
 * 使工程师能从一条 command.completed 结构化跳转到同会话的 agent spine。
 */
function extractCorrelationIdsInternal(payload: unknown, depth: number, out: Record<string, string>): void {
  // 永不抛出：敌对载荷（throwing getter / Proxy）最多损失关联 ID，不得影响调用方语义。
  // 子层扫描限量，避免大载荷上做全量 Object.values 物化。
  try {
    if (depth > 1 || payload == null || typeof payload !== 'object' || Array.isArray(payload)) return
    for (const [key, field] of CORRELATION_ID_KEYS) {
      if (out[field]) continue
      const candidate = (payload as Record<string, unknown>)[key]
      if (isValidIdShape(candidate)) out[field] = candidate
    }
    if (depth === 0) {
      const children = Object.entries(payload as Record<string, unknown>).slice(0, SUMMARIZE_MAX_KEYS)
      for (const [, child] of children) {
        extractCorrelationIdsInternal(child, 1, out)
      }
    }
  } catch {
    // ignore：关联 ID 是尽力而为的观测增强。
  }
}

/** 从载荷浅层（顶层与一层嵌套）提取已知关联 ID；永不抛出。 */
export function extractCorrelationIds(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  extractCorrelationIdsInternal(payload, 0, out)
  return out
}


export function summarizeValue(input: unknown, depth = 0): unknown {
  if (input == null || typeof input === 'boolean' || typeof input === 'number') return input
  if (typeof input === 'string') return clipLogPreview(input)
  if (typeof input !== 'object') return `[${typeof input}]`
  if (input instanceof Error) {
    return {
      name: input.name,
      message: clipLogPreview(input.message),
      ...(input.stack ? { stack: clipLogPreview(input.stack) } : {}),
    }
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    return {
      type: input.constructor?.name ?? 'TypedArray',
      byteLength: (input as { byteLength: number }).byteLength,
    }
  }
  if (depth >= SUMMARIZE_MAX_DEPTH) return '[MaxDepth]'
  if (Array.isArray(input)) {
    return {
      length: input.length,
      items: input.slice(0, 5).map((item) => summarizeValue(item, depth + 1)),
    }
  }
  const out: Record<string, unknown> = {}
  let keyCount = 0
  for (const key in input as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    if (keyCount >= SUMMARIZE_MAX_KEYS) break
    keyCount += 1
    let value: unknown
    try {
      value = (input as Record<string, unknown>)[key]
    } catch {
      out[clipKeyName(key)] = '[getter threw]'
      continue
    }
    const classified = classifyLogKey(key)
    const outKey = clipKeyName(key)
    if (classified === 'redact') {
      out[outKey] = '[redacted]'
      continue
    }
    // 内容键的对象值必须走递归分类：任何在此处直接 JSON 序列化的捷径都会让嵌套凭据绕过脱敏。
    out[outKey] = summarizeValue(value, depth + 1)
  }
  return out
}

// ── 跨进程复用的日志工具（第二波评审收敛项）──────────────────────────────

export function isLumeLogSource(value: unknown): value is LumeLogSource {
  return typeof value === "string" && (LUME_LOG_SOURCES as readonly string[]).includes(value);
}

/** 宿主上报级别归一：fatal 映射 error，白名单外回落 info。main 与 sidecar 共用同一策略。 */
export function normalizeHostLevel(level: unknown): LumeLogLevel {
  if (level === "fatal") return "error";
  return typeof level === "string" && level !== "fatal" && (LUME_LOG_LEVELS as readonly string[]).includes(level)
    ? (level as LumeLogLevel)
    : "info";
}

export const LUMELOG_PREFIX = "LUMELOG ";

/** 宿主 LUMELOG 行的类型视图：Rust log_line 恒定输出四个核心字符串字段（协议契约）。 */
export interface LumeHostLogLine {
  level: string;
  context: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * 解析宿主输出的单行结构化日志；非前缀/坏 JSON/非对象载荷/缺核心字段一律返回 null，
 * 由调用方决定回退路径。supervisor 与 node-repl runtime-manager 共用。
 */
export function parseLumeLogLine(line: string): LumeHostLogLine | null {
  if (!line.startsWith(LUMELOG_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(LUMELOG_PREFIX.length));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    // 协议核心四字段必为字符串：缺任一即视为不合规行，走调用方文本回退。
    for (const key of ["level", "context", "event", "message"] as const) {
      if (typeof candidate[key] !== "string") return null;
    }
    const data = candidate.data;
    if (data !== undefined && (typeof data !== "object" || Array.isArray(data))) return null;
    return parsed as LumeHostLogLine;
  } catch {
    return null;
  }
}

/** 三端重复的「规整结果断言」收敛：非对象包装一层 {value}，语义与 desktop safeRecord 一致。 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

const MAX_NORMALIZE_DEPTH = 6;
const MAX_NORMALIZE_KEYS = 100;
const MAX_NORMALIZE_ARRAY_ITEMS = 100;
const MAX_NORMALIZE_STRING_CHARS = 8_192;

export interface LogNormalizeState {
  seen: WeakSet<object>;
  keys: number;
}

function normalizeClip(text: string): string {
  return text.length > MAX_NORMALIZE_STRING_CHARS
    ? `${text.slice(0, MAX_NORMALIZE_STRING_CHARS)}…[truncated]`
    : text;
}

/**
 * 权威的日志数据规整器：三端（main/sidecar/renderer）共用同一份遍历骨架与上限
 * （深 6 / 键 100 / 数组 100 / 字符串 8K），杜绝拷贝间漂移。
 */
function normalizeLogValueInternal(
  value: unknown,
  depth = 0,
  state: LogNormalizeState = { seen: new WeakSet<object>(), keys: 0 },
): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return normalizeClip(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`;
  if (value instanceof Error) {
    return {
      name: normalizeClip(value.name),
      message: normalizeClip(value.message),
      ...(value.stack ? { stack: normalizeClip(value.stack) } : {}),
    };
  }
  if (depth >= MAX_NORMALIZE_DEPTH) return "[MaxDepth]";
  if (!value || typeof value !== "object") return normalizeClip(String(value));
  if (state.seen.has(value)) return "[Circular]";
  state.seen.add(value);

  // TypedArray/DataView/Buffer 输出骨架：否则 getOwnPropertyDescriptors 会物化数十万键。
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return { type: value.constructor?.name ?? "TypedArray", byteLength: (value as { byteLength: number }).byteLength };
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_NORMALIZE_ARRAY_ITEMS).map((item) => normalizeLogValueInternal(item, depth + 1, state));
  }

  const output: Record<string, unknown> = {};
  let descriptors: PropertyDescriptorMap;
  // getOwnPropertyDescriptors 会触发自有 getter——throwing getter 在此即抛，须整体兜底。
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return "[descriptor error]";
  }
  for (const key of Object.keys(descriptors).slice(0, MAX_NORMALIZE_KEYS)) {
    state.keys += 1;
    if (state.keys > MAX_NORMALIZE_KEYS) break;
    const classified = classifyLogKey(key);
    const outKey = key.length > MAX_KEY_NAME_CHARS ? `${key.slice(0, MAX_KEY_NAME_CHARS)}…` : key;
    if (classified === "redact") {
      output[outKey] = "[redacted]";
      continue;
    }
    const descriptor = descriptors[key];
    const resolved = descriptor && "value" in descriptor
      ? normalizeLogValueInternal(descriptor.value, depth + 1, state)
      : "[Accessor]";
    output[outKey] = classified === "preview" && typeof resolved === "string"
      ? clipLogPreview(resolved)
      : resolved;
  }
  return output;
}

/**
 * 永不抛出的规整入口：敌对输入（throwing getter / Proxy / descriptor 异常）降级为
 * 错误标记——日志观测绝不能反向影响业务调用方。
 */
export function normalizeLogValue(value: unknown, depth = 0, state?: LogNormalizeState): unknown {
  try {
    return normalizeLogValueInternal(value, depth, state)
  } catch {
    return { normalizeError: '[normalize threw]' }
  }
}
