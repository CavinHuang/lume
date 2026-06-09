/**
 * @lume/native-logger — TypeScript wrapper for the native lume-logger napi module.
 *
 * Loads the platform-specific .node binary and exposes typed functions.
 * Falls back gracefully when native is unavailable (e.g. missing binary).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface LoggerConfig {
  level?: LogLevel;
  file_enabled?: boolean;
  console_enabled?: boolean;
  retention_days?: number;
  max_file_size_mb?: number;
  redact_keys?: string[];
}

export interface LogInput {
  level: LogLevel;
  source?: string;
  context: string;
  message: string;
  data?: string;
}

export interface LogFileSummary {
  name: string;
  size_bytes: number;
  modified_at: string;
}

export interface LogLineEntry {
  line_number: number;
  level: string;
  text: string;
  raw_json?: string;
}

export interface LogQuery {
  file_name?: string;
  levels?: LogLevel[];
  keyword?: string;
  max_lines?: number;
}

// ── Native loading ────────────────────────────────────────

interface NativeModule {
  initLogger(config?: LoggerConfig): void;
  emitLog(input: LogInput): void;
  flushLogger(): void;
  listLogFiles(): LogFileSummary[];
  readLogFile(query?: LogQuery): LogLineEntry[];
}

let native: NativeModule | null = null;
let loadError: string | null = null;

try {
  const candidates = [
    "./dist/lume-logger-napi.darwin-arm64.node",
    "./dist/lume-logger-napi.darwin-x64.node",
    "./dist/lume-logger-napi.linux-x64-gnu.node",
    "./dist/lume-logger-napi.win32-x64-msvc.node",
  ];

  const searchDirs = [
    __dirname,
    // When compiled with bun build --compile, look next to the executable
    path.dirname(process.execPath),
  ];

  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      try {
        native = require(path.resolve(dir, candidate)) as NativeModule;
        break;
      } catch {
        // try next
      }
    }
    if (native) break;
  }

  if (!native) {
    loadError = "No platform native binary found";
  }
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err);
}

// ── Public API ────────────────────────────────────────────

/** Check if the native logger module is available. */
export function isNativeAvailable(): boolean {
  return native !== null;
}

/** Get the load error if native is unavailable, null otherwise. */
export function getLoadError(): string | null {
  return loadError;
}

/** Initialize the native logger. No-op if native is unavailable. */
export function initLogger(config?: LoggerConfig): void {
  native?.initLogger(config);
}

/** Emit a structured log event. Falls back to stderr if native unavailable. */
export function emitLog(input: LogInput): void {
  if (native) {
    native.emitLog(input);
  } else {
    // Fallback: write to stderr so desktop's stderr reader captures it
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: input.level,
      source: input.source ?? "sidecar",
      context: input.context,
      message: input.message,
      ...(input.data ? { data: JSON.parse(input.data) } : {}),
    });
    process.stderr.write(`${line}\n`);
  }
}

/** Flush pending log writes to disk. */
export function flushLogger(): void {
  native?.flushLogger();
}

/** List log files. Returns empty array if native unavailable. */
export function listLogFiles(): LogFileSummary[] {
  return native?.listLogFiles() ?? [];
}

/** Read log file with optional filtering. Returns empty array if native unavailable. */
export function readLogFile(query?: LogQuery): LogLineEntry[] {
  return native?.readLogFile(query) ?? [];
}
