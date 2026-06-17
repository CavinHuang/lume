/**
 * @lume/natives — High-performance Rust primitives for Lume.
 *
 * Loads the platform-specific .node binary and exposes typed APIs.
 * Falls back gracefully when native binary is unavailable.
 *
 * Sourced from oh-my-pi (pi-natives) with adaptations.
 * License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──────────────────────────────────────────────

export interface TokenCountInput {
  text: string | string[];
  model?: string;
}

export interface TokenCountResult {
  count: number;
}

export interface NativeGrepOptions {
  pattern: string;
  path: string;
  glob?: string;
  type?: string;
  ignore_case?: boolean;
  multiline?: boolean;
  hidden?: boolean;
  gitignore?: boolean;
  cache?: boolean;
  max_count?: number;
  offset?: number;
  context_before?: number;
  context_after?: number;
  context?: number;
  max_columns?: number;
  mode?: "content" | "count" | "filesWithMatches";
  max_count_per_file?: number;
  timeout_ms?: number;
}

export interface NativeGrepMatch {
  path: string;
  line_number: number;
  line: string;
  context_before?: Array<{ line_number: number; line: string }>;
  context_after?: Array<{ line_number: number; line: string }>;
  truncated?: boolean;
  match_count?: number;
}

export interface NativeGrepResult {
  matches: NativeGrepMatch[];
  total_matches: number;
  files_with_matches: number;
  files_searched?: number;
  limit_reached?: boolean;
  skipped_oversized?: number;
  error?: string;
}

export interface NativeGlobOptions {
  pattern: string;
  path: string;
  file_type?: "file" | "dir" | "symlink";
  recursive?: boolean;
  hidden?: boolean;
  max_results?: number;
  gitignore?: boolean;
  cache?: boolean;
  sort_by_mtime?: boolean;
  include_node_modules?: boolean;
  timeout_ms?: number;
}

export interface NativeGlobMatch {
  path: string;
  file_type: "file" | "dir" | "symlink";
  mtime: number | null;
  size: number | null;
}

export interface NativeGlobResult {
  matches: NativeGlobMatch[];
  total_matches: number;
}

// ── Native loader ──────────────────────────────────────

type NativeModule = {
  countTokens(input: TokenCountInput): TokenCountResult;
  grep(options: NativeGrepOptions): Promise<NativeGrepResult>;
  search(
    content: string,
    options: {
      pattern: string;
      ignore_case?: boolean;
      multiline?: boolean;
      max_count?: number;
      offset?: number;
      context_before?: number;
      context_after?: number;
      context?: number;
      max_columns?: number;
    },
  ): { matches: NativeGrepMatch[]; total: number; error?: string };
  hasMatch(
    content: string,
    pattern: string,
    ignore_case?: boolean,
    multiline?: boolean,
  ): boolean;
  glob(options: NativeGlobOptions): Promise<NativeGlobResult>;
  fuzzyFind(options: {
    query: string;
    path: string;
    hidden?: boolean;
    gitignore?: boolean;
    cache?: boolean;
    max_results?: number;
    timeout_ms?: number;
  }): Promise<{
    matches: Array<{
      path: string;
      is_directory: boolean;
      score: number;
    }>;
    total_matches: number;
  }>;
  invalidateFsScanCache(): void;

  // ── Logger NAPI (merged from lume-logger-napi) ────────
  initLogger(config?: {
    level?: string;
    file_enabled?: boolean;
    console_enabled?: boolean;
    retention_days?: number;
    max_file_size_mb?: number;
    redact_keys?: string[];
  }): void;
  emitLog(input: {
    level: string;
    source?: string;
    context: string;
    message: string;
    data?: string;
  }): void;
  flushLogger(): void;
  listLogFiles(): Array<{
    name: string;
    size_bytes: number;
    modified_at: string;
  }>;
  readLogFile(query?: {
    file_name?: string;
    levels?: string[];
    keyword?: string;
    max_lines?: number;
  }): Array<{
    line_number: number;
    level: string;
    text: string;
    raw_json?: string;
  }>;
};

let _native: NativeModule | null = null;
let _loadError: string | null = null;

function loadNative(): NativeModule | null {
  if (_native !== null || _loadError !== null) return _native;

  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const platform = process.platform;
    const arch = process.arch;

    let binaryName: string;
    if (platform === "darwin" && arch === "arm64") {
      binaryName = "lume-natives.darwin-arm64.node";
    } else if (platform === "darwin" && arch === "x64") {
      binaryName = "lume-natives.darwin-x64.node";
    } else if (platform === "linux" && arch === "x64") {
      binaryName = "lume-natives.linux-x64-gnu.node";
    } else if (platform === "win32" && arch === "x64") {
      binaryName = "lume-natives.win32-x64-msvc.node";
    } else {
      _loadError = `unsupported platform: ${platform}-${arch}`;
      return null;
    }

    // Desktop bundle: the shell sets LUME_NATIVES_PATH to the bundled .node file.
    // Fallback: look relative to this file's location in the package tree (dev mode).
    const envPath = process.env.LUME_NATIVES_PATH?.trim();
    const binaryPath =
      envPath && envPath.length > 0
        ? envPath
        : path.join(__dirname, "dist", binaryName);
    _native = require(binaryPath) as unknown as NativeModule;
    return _native;
  } catch (err) {
    _loadError = `failed to load native module: ${err}`;
    return null;
  }
}

export function isNativeAvailable(): boolean {
  return loadNative() !== null;
}

// ── Tokens ─────────────────────────────────────────────

export function countTokens(input: TokenCountInput): TokenCountResult | null {
  const native = loadNative();
  if (!native) return null;
  return native.countTokens(input);
}

export function countStringTokens(text: string, model?: string): number {
  const result = countTokens({ text, model });
  return result?.count ?? 0;
}

// ── Grep ───────────────────────────────────────────────

/**
 * Native ripgrep search over files. Returns null if native unavailable.
 * This is an async operation (returns Promise).
 */
export async function nativeGrep(
  options: NativeGrepOptions,
): Promise<NativeGrepResult | null> {
  const native = loadNative();
  if (!native) return null;

  try {
    return await native.grep(options);
  } catch {
    return null;
  }
}

/**
 * Search content string for a pattern (synchronous, in-memory).
 */
export function nativeSearch(
  content: string,
  pattern: string,
  options?: { ignore_case?: boolean; context?: number; max_count?: number },
): NativeGrepMatch[] | null {
  const native = loadNative();
  if (!native) return null;

  try {
    const result = native.search(content, {
      pattern,
      ignore_case: options?.ignore_case,
      context: options?.context,
      max_count: options?.max_count,
    });
    return result.matches;
  } catch {
    return null;
  }
}

// ── Glob ───────────────────────────────────────────────

/**
 * Native glob file discovery. Returns null if native unavailable.
 * This is an async operation (returns Promise).
 */
export async function nativeGlob(
  options: NativeGlobOptions,
): Promise<NativeGlobResult | null> {
  const native = loadNative();
  if (!native) return null;

  try {
    return await native.glob(options);
  } catch {
    return null;
  }
}

// ── Fuzzy Find (fd) ────────────────────────────────────

/**
 * Native fuzzy file find. Returns null if native unavailable.
 * This is an async operation (returns Promise).
 */
export async function nativeFuzzyFind(
  query: string,
  searchPath: string,
  maxResults?: number,
): Promise<Array<{ path: string; is_directory: boolean; score: number }> | null> {
  const native = loadNative();
  if (!native) return null;

  try {
    const result = await native.fuzzyFind({
      query,
      path: searchPath,
      max_results: maxResults ?? 100,
    });
    return result.matches;
  } catch {
    return null;
  }
}

// ── Summarize (AST) ───────────────────────────────────

export interface NativeSummarizeOptions {
  code: string;
  lang?: string;
  path?: string;
  min_body_lines?: number;
  min_comment_lines?: number;
  unfold_until_lines?: number;
  unfold_limit_lines?: number;
}

export interface NativeSummarySegment {
  kind: "kept" | "elided";
  startLine: number;
  endLine: number;
  text?: string;
}

export interface NativeSummaryResult {
  language: string | null;
  parsed: boolean;
  elided: boolean;
  totalLines: number;
  segments: NativeSummarySegment[];
}

/**
 * Produce a structural summary of source code using tree-sitter.
 * Returns kept/elided segments showing signatures with bodies elided.
 * Returns null if native module unavailable.
 */
export function nativeSummarize(
  options: NativeSummarizeOptions,
): NativeSummaryResult | null {
  const native = loadNative();
  if (!native) return null;

  try {
    return (native as any).summarize(options);
  } catch {
    return null;
  }
}

// ── Logger (merged from @lume/native-logger) ─────────────

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

/** Initialize the native logger. No-op if native unavailable. */
export function initLogger(config?: LoggerConfig): void {
  loadNative()?.initLogger(config);
}

/** Emit a structured log event. Falls back to stderr if native unavailable. */
export function emitLog(input: LogInput): void {
  const n = loadNative();
  if (n) {
    n.emitLog(input);
  } else {
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
  loadNative()?.flushLogger();
}

/** List log files. Returns empty array if native unavailable. */
export function listLogFiles(): LogFileSummary[] {
  return loadNative()?.listLogFiles() ?? [];
}

/** Read log file with optional filtering. Returns empty array if native unavailable. */
export function readLogFile(query?: LogQuery): LogLineEntry[] {
  return loadNative()?.readLogFile(query) ?? [];
}
