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

function getResolvedLogsDir(): string {
  if (!logsDir) {
    logsDir = resolveLogsDir();
  }
  return logsDir;
}

// 获取当前日期字符串
function getDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// 日志级别
type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

// 从环境变量读取配置
const MIN_LEVEL: LogLevel = (process.env.LUME_LOG_LEVEL as LogLevel) || "info";
const CONSOLE_ENABLED = process.env.LUME_LOG_CONSOLE !== "false";

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

function getBaseLogger(): LoggerBackend {
  if (baseLogger) {
    return baseLogger;
  }

  const transports: Array<{ target: string; options: Record<string, unknown> }> = [
    {
      target: "pino/file",
      options: {
        destination: join(getResolvedLogsDir(), `${getDateStr()}.log`),
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
      console.warn("[logger] pino unavailable, falling back to console logger", {
        error: error instanceof Error ? error.message : String(error)
      });
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

// 创建带上下文的日志器
export function createLogger(context: string, sessionId?: string): Logger {
  const getChild = () => getBaseLogger().child({ context, sessionId });
  const write = (
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
    msg: string,
    data?: Record<string, unknown>
  ): void => {
    const payload = data ?? {};
    if (CONSOLE_ENABLED) {
      emitConsoleLine(formatStructuredLogLine({
        source: LOG_SOURCE,
        context,
        message: msg,
        data: payload
      }));
    }
    getChild()[level](payload, msg);
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
  return join(getResolvedLogsDir(), `${getDateStr()}.log`);
}
