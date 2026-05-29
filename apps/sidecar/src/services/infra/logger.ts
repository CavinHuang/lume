/**
 * 日志服务
 * - 优先使用 pino
 * - pino 不可用时回退到 console，避免运行时因日志依赖阻塞主流程或测试
 */

import { mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stderr } from "node:process";
import { getConfigDir } from "./config-paths";
import { formatStructuredLogLine } from "./log-format";

function resolveLogsDir(): string {
  const candidates = [
    join(getConfigDir(), "logs"),
    join(tmpdir(), "lume-logs")
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

let logsDir: string | null = null;
let logsDirCacheKey: string | null = null;

function getResolvedLogsDir(): string {
  const cacheKey = process.env.LUME_CONFIG_DIR?.trim() || "";
  if (!logsDir || logsDirCacheKey !== cacheKey) {
    logsDir = resolveLogsDir();
    logsDirCacheKey = cacheKey;
  }
  return logsDir;
}

export function getCurrentLogFileName(date = new Date()): string {
  return `lume-${date.toISOString().slice(0, 10)}.log`;
}

export function shouldWriteLogFile(value = process.env.LUME_LOG_FILE): boolean {
  return value?.trim().toLowerCase() !== "false";
}

// 日志级别
type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

// 从环境变量读取配置
const MIN_LEVEL: LogLevel = (process.env.LUME_LOG_LEVEL as LogLevel) || "info";
const CONSOLE_ENABLED = process.env.LUME_LOG_CONSOLE !== "false";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5
};

interface LoggerBackend {
  child(bindings: { context?: string; sessionId?: string }): LoggerBackend;
  trace(data: Record<string, unknown>, msg: string): void;
  debug(data: Record<string, unknown>, msg: string): void;
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
  fatal(data: Record<string, unknown>, msg: string): void;
}

const LOG_SOURCE = "sidecar";

const require = createRequire(import.meta.url);
let baseLogger: LoggerBackend | null = null;
let didWarnPinoUnavailable = false;

function createConsoleBackend(bindings: { context?: string; sessionId?: string } = {}): LoggerBackend {
  return {
    child(nextBindings) {
      return createConsoleBackend({
        ...bindings,
        ...nextBindings
      });
    },
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {}
  };
}

function emitConsoleLine(line: string): void {
  stderr.write(`${line}\n`);
}

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
      ...(input.stack ? { stack: input.stack } : {})
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

function getBaseLogger(): LoggerBackend {
  if (baseLogger) {
    return baseLogger;
  }

  if (!shouldWriteLogFile()) {
    baseLogger = createConsoleBackend();
    return baseLogger;
  }

  const transports: Array<{ target: string; options: Record<string, unknown> }> = [
    {
      target: "pino/file",
      options: {
        destination: join(getResolvedLogsDir(), getCurrentLogFileName()),
        mkdir: true
      }
    }
  ];

  try {
    const pinoModule = require("pino") as {
      default: ((options: Record<string, unknown>, destination: unknown) => LoggerBackend) & {
        transport: (options: Record<string, unknown>) => unknown;
        stdTimeFunctions: { isoTime: () => string };
      };
    };
    const pino = pinoModule.default;
    baseLogger = pino(
      {
        level: MIN_LEVEL,
        timestamp: pino.stdTimeFunctions.isoTime
      },
      pino.transport({ targets: transports })
    );
    return baseLogger;
  } catch (error) {
    if (!didWarnPinoUnavailable) {
      didWarnPinoUnavailable = true;
      emitConsoleLine(formatStructuredLogLine({
        source: LOG_SOURCE,
        context: "logger",
        message: "pino unavailable, falling back to console logger",
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      }));
    }
    baseLogger = createConsoleBackend();
  }
  return baseLogger;
}

// 上下文日志器
export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  child(bindings: { context?: string; sessionId?: string }): Logger;
}

export function writeLogRecord(input: {
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  context: string;
  message: string;
  data?: Record<string, unknown>;
  sessionId?: string;
}): void {
  const payload = redactDiagnosticLogData(input.data ?? {}) as Record<string, unknown>;
  getBaseLogger().child({
    context: input.context,
    ...(input.sessionId ? { sessionId: input.sessionId } : {})
  })[input.level](payload, input.message);
}

// 创建带上下文的日志器
export function createLogger(context: string, sessionId?: string): Logger {
  const write = (
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
    msg: string,
    data?: Record<string, unknown>
  ): void => {
    const payload = redactDiagnosticLogData(data ?? {}) as Record<string, unknown>;
    if (CONSOLE_ENABLED && LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL]) {
      emitConsoleLine(formatStructuredLogLine({
        source: LOG_SOURCE,
        context,
        message: msg,
        data: payload
      }));
    }
    writeLogRecord({
      level,
      context,
      message: msg,
      data: payload,
      sessionId
    });
  };

  return {
    trace: (msg: string, data?: Record<string, unknown>) => write("trace", msg, data),
    debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
    info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
    error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
    fatal: (msg: string, data?: Record<string, unknown>) => write("fatal", msg, data),
    child: (bindings) => createLogger(bindings.context ?? context, bindings.sessionId ?? sessionId)
  };
}

// 默认导出
export const logger = {
  trace: (msg: string, data?: Record<string, unknown>) => createLogger("app").trace(msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => createLogger("app").debug(msg, data),
  info: (msg: string, data?: Record<string, unknown>) => createLogger("app").info(msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => createLogger("app").warn(msg, data),
  error: (msg: string, data?: Record<string, unknown>) => createLogger("app").error(msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => createLogger("app").fatal(msg, data),
  child: (bindings: { context?: string; sessionId?: string }) =>
    createLogger(bindings.context ?? "app", bindings.sessionId)
} satisfies Logger;

// 获取日志目录路径
export function getLogsDir(): string {
  return getResolvedLogsDir();
}

// 获取当前日志文件路径
export function getCurrentLogPath(): string {
  return join(getResolvedLogsDir(), getCurrentLogFileName());
}
