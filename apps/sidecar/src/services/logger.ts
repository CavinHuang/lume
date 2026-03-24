/**
 * 日志服务 - 基于 pino 实现
 * - 自动写入本地文件（按日期分割）
 * - 支持控制台美化输出
 * - 支持会话关联
 */

import pino from "pino";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigDir } from "./config-paths";

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

let baseLogger: pino.Logger | null = null;

function getBaseLogger(): pino.Logger {
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

  if (CONSOLE_ENABLED) {
    transports.push({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname"
      }
    });
  }

  baseLogger = pino(
    {
      level: MIN_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime
    },
    pino.transport({ targets: transports })
  );
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

  return {
    trace: (msg: string, data?: Record<string, unknown>) => getChild().trace(data ?? {}, msg),
    debug: (msg: string, data?: Record<string, unknown>) => getChild().debug(data ?? {}, msg),
    info: (msg: string, data?: Record<string, unknown>) => getChild().info(data ?? {}, msg),
    warn: (msg: string, data?: Record<string, unknown>) => getChild().warn(data ?? {}, msg),
    error: (msg: string, data?: Record<string, unknown>) => getChild().error(data ?? {}, msg),
    fatal: (msg: string, data?: Record<string, unknown>) => getChild().fatal(data ?? {}, msg),
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
