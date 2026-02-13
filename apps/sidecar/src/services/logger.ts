/**
 * 日志服务 - 基于 pino 实现
 * - 自动写入本地文件（按日期分割）
 * - 支持控制台美化输出
 * - 支持会话关联
 */

import pino from "pino";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOGS_DIR = join(homedir(), ".lume", "logs");

// 确保日志目录存在
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
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

// 创建日志传输配置
const transports = [];

// 文件传输 - 多行 JSON 格式
transports.push({
  target: "pino/file",
  options: {
    destination: join(LOGS_DIR, `${getDateStr()}.log`),
    mkdir: true
  }
});

// 控制台传输 - 美化输出
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

// 创建 logger 实例
const baseLogger = pino(
  {
    level: MIN_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime
  },
  pino.transport({ targets: transports })
);

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
  const child = baseLogger.child({ context, sessionId });

  return {
    trace: (msg: string, data?: Record<string, unknown>) => child.trace(data ?? {}, msg),
    debug: (msg: string, data?: Record<string, unknown>) => child.debug(data ?? {}, msg),
    info: (msg: string, data?: Record<string, unknown>) => child.info(data ?? {}, msg),
    warn: (msg: string, data?: Record<string, unknown>) => child.warn(data ?? {}, msg),
    error: (msg: string, data?: Record<string, unknown>) => child.error(data ?? {}, msg),
    fatal: (msg: string, data?: Record<string, unknown>) => child.fatal(data ?? {}, msg),
    child: (bindings) => createLogger(bindings.context ?? context, bindings.sessionId ?? sessionId)
  };
}

// 默认导出
export const logger = createLogger("app");

// 获取日志目录路径
export function getLogsDir(): string {
  return LOGS_DIR;
}

// 获取当前日志文件路径
export function getCurrentLogPath(): string {
  return join(LOGS_DIR, `${getDateStr()}.log`);
}
