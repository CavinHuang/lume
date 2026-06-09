/**
 * 统一日志服务
 *
 * 通过 @lume/native-logger (napi) 调用 Rust lume-logger 核心，
 * 所有日志统一写入 ~/.lume/logs/lume-YYYY-MM-DD.ndjson。
 *
 * native 不可用时 fallback 到 stderr，
 * 由 Desktop 的 stderr reader 兜底收集。
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { stderr } from "node:process";
import { existsSync, mkdirSync } from "node:fs";
import {
  initLogger as nativeInit,
  emitLog as nativeEmitLog,
  isNativeAvailable,
  type LogLevel,
  type LogInput,
} from "@lume/native-logger";
import { formatStructuredLogLine } from "./log-format";

// ── 日志目录 ───────────────────────────────────────────────

function resolveLogsDir(): string {
  const candidates = [
    join(getConfigDir(), "logs"),
    join(tmpdir(), "lume-logs"),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) {
        mkdirSync(candidate, { recursive: true });
      }
      return candidate;
    } catch {
      continue;
    }
  }
  return join(tmpdir(), "lume-logs");
}

function getConfigDir(): string {
  const val = process.env.LUME_CONFIG_DIR?.trim();
  if (val) return val;
  const home = process.env.HOME;
  if (home) return join(home, ".lume");
  return join(tmpdir(), "lume");
}

let logsDir: string | null = null;

function getResolvedLogsDir(): string {
  if (!logsDir) {
    logsDir = resolveLogsDir();
  }
  return logsDir;
}

// ── 初始化 native logger ──────────────────────────────────

const MIN_LEVEL: LogLevel = (process.env.LUME_LOG_LEVEL as LogLevel) || "info";

let nativeReady = false;

try {
  nativeInit({
    level: MIN_LEVEL,
    fileEnabled: true,
    consoleEnabled: false,
  });
  nativeReady = isNativeAvailable();
} catch {
  nativeReady = false;
}

// ── 敏感数据脱敏（保留给 createDiagnosticLogSummary 使用）───

function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("apikey")
    || normalized.includes("authorization");
}

export function redactDiagnosticLogData(input: unknown, seen = new WeakSet<object>()): unknown {
  if (input instanceof Error) {
    return {
      name: input.name,
      message: input.message,
      ...(input.stack ? { stack: input.stack } : {}),
    };
  }
  if (typeof input === "bigint") {
    return input.toString();
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactDiagnosticLogData(item, seen));
  }
  if (input && typeof input === "object") {
    if (seen.has(input)) {
      return "[Circular]";
    }
    seen.add(input);
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = isSensitiveDiagnosticKey(key) ? "[redacted]" : redactDiagnosticLogData(value, seen);
    }
    return output;
  }
  return input;
}

export function createDiagnosticLogSummary(input: unknown, maxChars = 500): string {
  const redacted = redactDiagnosticLogData(input);
  let text: string;
  try {
    text = typeof redacted === "string" ? redacted : JSON.stringify(redacted ?? {});
  } catch {
    text = String(redacted);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...(truncated)`;
}

// ── Logger 接口与 createLogger ─────────────────────────────

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  child(bindings: { context?: string; sessionId?: string }): Logger;
}

const LOG_SOURCE = "sidecar";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

function emit(level: LogLevel, context: string, msg: string, data?: Record<string, unknown>): void {
  const payload = redactDiagnosticLogData(data ?? {}) as Record<string, unknown>;

  if (nativeReady) {
    nativeEmitLog({
      level,
      source: LOG_SOURCE,
      context,
      message: msg,
      data: Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined,
    });
  } else {
    // Fallback: write NDJSON to stderr for Desktop's stderr reader
    stderr.write(
      formatStructuredLogLine({
        source: LOG_SOURCE,
        context,
        message: msg,
        data: payload,
      }) + "\n"
    );
  }
}

export function createLogger(context: string, sessionId?: string): Logger {
  const write = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (!shouldEmit(level)) return;
    emit(level, context, msg, data);
  };

  return {
    trace: (msg, data) => write("trace", msg, data),
    debug: (msg, data) => write("debug", msg, data),
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
    fatal: (msg, data) => write("fatal", msg, data),
    child: (bindings) => createLogger(bindings.context ?? context, bindings.sessionId ?? sessionId),
  };
}

// ── writeLogRecord（兼容 index.ts 引用）────────────────────

export function writeLogRecord(input: {
  level: LogLevel;
  context: string;
  message: string;
  data?: Record<string, unknown>;
  sessionId?: string;
}): void {
  if (!shouldEmit(input.level)) return;
  emit(input.level, input.context, input.message, input.data);
}

// ── 默认导出 ───────────────────────────────────────────────

export const logger = {
  trace: (msg: string, data?: Record<string, unknown>) => createLogger("app").trace(msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => createLogger("app").debug(msg, data),
  info: (msg: string, data?: Record<string, unknown>) => createLogger("app").info(msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => createLogger("app").warn(msg, data),
  error: (msg: string, data?: Record<string, unknown>) => createLogger("app").error(msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => createLogger("app").fatal(msg, data),
  child: (bindings: { context?: string; sessionId?: string }) =>
    createLogger(bindings.context ?? "app", bindings.sessionId),
} satisfies Logger;

// ── 路径访问（兼容外部引用）───────────────────────────────

export function getLogsDir(): string {
  return getResolvedLogsDir();
}

export function getCurrentLogFileName(date = new Date()): string {
  return `lume-${date.toISOString().slice(0, 10)}.ndjson`;
}

export function getCurrentLogPath(): string {
  return join(getResolvedLogsDir(), getCurrentLogFileName());
}

export function shouldWriteLogFile(value = process.env.LUME_LOG_FILE): boolean {
  return value?.trim().toLowerCase() !== "false";
}
