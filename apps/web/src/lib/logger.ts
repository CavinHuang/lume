/**
 * Webview logger utility.
 *
 * Usage:
 *   const log = createWebLogger("settings.log-viewer");
 *   log.info("log file selected", { fileName: "lume-2026-06-09.ndjson" });
 *   log.error("failed to load logs", { error: err.message });
 */

import { writeWebLog } from "./desktop-api/logger";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export function createWebLogger(context: string) {
  const emit = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    writeWebLog(level, context, message, data);
  };

  return {
    trace: (msg: string, data?: Record<string, unknown>) => emit("trace", msg, data),
    debug: (msg: string, data?: Record<string, unknown>) => emit("debug", msg, data),
    info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
    error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
    fatal: (msg: string, data?: Record<string, unknown>) => emit("fatal", msg, data),
  };
}

export type WebLogger = ReturnType<typeof createWebLogger>;
