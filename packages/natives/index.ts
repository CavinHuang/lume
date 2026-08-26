/**
 * @lume/natives — High-performance Rust primitives for Lume.
 *
 * Loads the platform-specific .node binary and exposes typed APIs.
 * Falls back gracefully when native binary is unavailable.
 *
 * Sourced from oh-my-pi (pi-natives) with adaptations.
 * License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük
 */

import { createRequire } from "node:module";
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

export interface NativeListWorkspaceOptions {
  path: string;
  max_depth: number;
  hidden?: boolean;
  gitignore?: boolean;
  collect_agents_md?: boolean;
  timeout_ms?: number;
}

export interface NativeListWorkspaceResult {
  entries: NativeGlobMatch[];
  agents_md_files: string[];
  truncated: boolean;
}

export interface NativeBashCommand {
  argv: string[];
}

export interface NativeBashAnalysis {
  status: "simple" | "too-complex" | "parse-unavailable";
  commands: NativeBashCommand[];
  has_pipeline?: boolean;
  has_redirection?: boolean;
  hasPipeline?: boolean;
  hasRedirection?: boolean;
}

// ── Native loader ──────────────────────────────────────

type NativeModule = {
  countTokens(input: TokenCountInput): TokenCountResult;
  grep(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  search(
    content: string,
    options: Record<string, unknown>,
  ): Record<string, unknown>;
  hasMatch(
    content: string,
    pattern: string,
    ignore_case?: boolean,
    multiline?: boolean,
  ): boolean;
  glob(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  listWorkspace(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  fuzzyFind(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  invalidateFsScanCache(path?: string): void;
  // napi-derive exposes the Rust snake_case options as camelCase at the FFI
  // boundary; the old snake_case declaration here masked the mismatch (#239).
  summarize(options: {
    code: string;
    lang?: string;
    path?: string;
    minBodyLines?: number;
    minCommentLines?: number;
    unfoldUntilLines?: number;
    unfoldLimitLines?: number;
  }): NativeSummaryResult;
  analyzeBash?(command: string): NativeBashAnalysis;
};

let _native: NativeModule | null = null;
let _loadError: string | null = null;
let _binaryPath: string | null = null;
const requireNative = createRequire(import.meta.url);

export const NATIVE_CAPABILITIES = [
  "tokens",
  "search",
  "grep",
  "glob",
  "fuzzyFind",
  "workspace",
  "summarize",
  "fsCache",
  "bashAnalysis",
] as const;

type NativeCapability = typeof NATIVE_CAPABILITIES[number];

const REQUIRED_EXPORTS: Array<[NativeCapability, keyof NativeModule]> = [
  ["tokens", "countTokens"],
  ["search", "search"],
  ["search", "hasMatch"],
  ["grep", "grep"],
  ["glob", "glob"],
  ["fuzzyFind", "fuzzyFind"],
  ["workspace", "listWorkspace"],
  ["summarize", "summarize"],
  ["fsCache", "invalidateFsScanCache"],
];

export interface NativeDiagnostics {
  available: boolean;
  binaryPath: string | null;
  error: string | null;
  capabilities: string[];
}

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
    } else if (platform === "linux" && arch === "arm64") {
      binaryName = "lume-natives.linux-arm64-gnu.node";
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
    _binaryPath = binaryPath;
    const loaded = requireNative(binaryPath) as unknown as NativeModule;
    validateNativeModule(loaded);
    _native = loaded;
    return _native;
  } catch (err) {
    _loadError = `failed to load native module: ${err}`;
    return null;
  }
}

function validateNativeModule(native: NativeModule): void {
  const missing = REQUIRED_EXPORTS
    .map(([, exportName]) => exportName)
    .filter((exportName) => typeof native[exportName] !== "function");
  if (missing.length > 0) {
    throw new Error(`missing native exports: ${missing.join(", ")}`);
  }
}

const FILE_TYPE_TO_NATIVE = {
  file: 1,
  dir: 2,
  symlink: 3,
} as const;

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function toNativeGrepOptions(options: NativeGrepOptions): Record<string, unknown> {
  return omitUndefined({
    pattern: options.pattern,
    path: options.path,
    glob: options.glob,
    type: options.type,
    ignoreCase: options.ignore_case,
    multiline: options.multiline,
    hidden: options.hidden,
    gitignore: options.gitignore,
    cache: options.cache,
    maxCount: options.max_count,
    offset: options.offset,
    contextBefore: options.context_before,
    contextAfter: options.context_after,
    context: options.context,
    maxColumns: options.max_columns,
    mode: options.mode,
    maxCountPerFile: options.max_count_per_file,
    timeoutMs: options.timeout_ms,
  });
}

function toNativeGlobOptions(options: NativeGlobOptions): Record<string, unknown> {
  return omitUndefined({
    pattern: options.pattern,
    path: options.path,
    fileType: options.file_type ? FILE_TYPE_TO_NATIVE[options.file_type] : undefined,
    recursive: options.recursive,
    hidden: options.hidden,
    maxResults: options.max_results,
    gitignore: options.gitignore,
    cache: options.cache,
    sortByMtime: options.sort_by_mtime,
    includeNodeModules: options.include_node_modules,
    timeoutMs: options.timeout_ms,
  });
}

function toNativeListWorkspaceOptions(options: NativeListWorkspaceOptions): Record<string, unknown> {
  return omitUndefined({
    path: options.path,
    maxDepth: options.max_depth,
    hidden: options.hidden,
    gitignore: options.gitignore,
    collectAgentsMd: options.collect_agents_md,
    timeoutMs: options.timeout_ms,
  });
}

function toNativeFuzzyFindOptions(
  query: string,
  searchPath: string,
  maxResults?: number,
): Record<string, unknown> {
  return omitUndefined({
    query,
    path: searchPath,
    maxResults: maxResults ?? 100,
  });
}

function toNativeSearchOptions(
  pattern: string,
  options?: {
    ignore_case?: boolean;
    multiline?: boolean;
    context?: number;
    max_count?: number;
  },
): Record<string, unknown> {
  return omitUndefined({
    pattern,
    ignoreCase: options?.ignore_case,
    multiline: options?.multiline,
    context: options?.context,
    maxCount: options?.max_count,
  });
}

function nativeFileTypeToString(value: unknown): "file" | "dir" | "symlink" {
  if (value === 1 || value === "file" || value === "File") return "file";
  if (value === 2 || value === "dir" || value === "Dir") return "dir";
  return "symlink";
}

function normalizeContextLines(value: unknown): Array<{ line_number: number; line: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((line) => ({
    line_number: Number(line.line_number ?? line.lineNumber ?? 0),
    line: String(line.line ?? ""),
  }));
}

function normalizeGrepMatch(match: any): NativeGrepMatch {
  return {
    path: String(match.path ?? ""),
    line_number: Number(match.line_number ?? match.lineNumber ?? 0),
    line: String(match.line ?? ""),
    context_before: normalizeContextLines(match.context_before ?? match.contextBefore),
    context_after: normalizeContextLines(match.context_after ?? match.contextAfter),
    truncated: match.truncated,
    match_count: match.match_count ?? match.matchCount,
  };
}

function normalizeGrepResult(result: any): NativeGrepResult {
  return {
    matches: Array.isArray(result.matches) ? result.matches.map(normalizeGrepMatch) : [],
    total_matches: Number(result.total_matches ?? result.totalMatches ?? 0),
    files_with_matches: Number(result.files_with_matches ?? result.filesWithMatches ?? 0),
    files_searched: Number(result.files_searched ?? result.filesSearched ?? 0),
    limit_reached: result.limit_reached ?? result.limitReached,
    skipped_oversized: result.skipped_oversized ?? result.skippedOversized,
    error: result.error,
  };
}

function normalizeGlobMatch(match: any): NativeGlobMatch {
  return {
    path: String(match.path ?? ""),
    file_type: nativeFileTypeToString(match.file_type ?? match.fileType),
    mtime: match.mtime ?? null,
    size: match.size ?? null,
  };
}

function normalizeGlobResult(result: any): NativeGlobResult {
  const matches = Array.isArray(result.matches)
    ? result.matches.map(normalizeGlobMatch)
    : [];
  return {
    matches,
    total_matches: Number(result.total_matches ?? result.totalMatches ?? matches.length),
  };
}

function normalizeWorkspaceResult(result: any): NativeListWorkspaceResult {
  return {
    entries: Array.isArray(result.entries) ? result.entries.map(normalizeGlobMatch) : [],
    agents_md_files: result.agents_md_files ?? result.agentsMdFiles ?? [],
    truncated: Boolean(result.truncated),
  };
}

export function isNativeAvailable(): boolean {
  return loadNative() !== null;
}

export function getNativeDiagnostics(): NativeDiagnostics {
  const native = loadNative();
  return {
    available: native !== null,
    binaryPath: _binaryPath,
    error: _loadError,
    capabilities: native ? NATIVE_CAPABILITIES.filter((capability) => capability !== "bashAnalysis" || typeof native.analyzeBash === "function") : [],
  };
}

export function assertNativeAvailable(): NativeDiagnostics {
  const diagnostics = getNativeDiagnostics();
  if (!diagnostics.available) {
    throw new Error(`Rust native module unavailable: ${diagnostics.error ?? "unknown error"}`);
  }
  return diagnostics;
}

// ── Tokens ─────────────────────────────────────────────

/**
 * tiktoken-rs 对「单条无换行的同构字符长游程」会递归触发 Rust 栈溢出
 * panic(#763)——进程级致命，JS try/catch 兜不住。超长输入在此定长硬切，
 * 与 sdk 侧 #736 分块同参数（8KB 线性安全区，漂移 +0.009%），消除
 * 「任何新消费方直调即崩」暗雷。
 */
const TOKEN_PIECE_LIMIT = 8 * 1024;

function countTextChunked(text: string, model?: string): number {
  const native = loadNative();
  if (!native) return 0;
  let total = 0;
  for (let start = 0; start < text.length; start += TOKEN_PIECE_LIMIT) {
    total += native.countTokens({ text: text.slice(start, start + TOKEN_PIECE_LIMIT), model })?.count ?? 0;
  }
  return total;
}

export function countTokens(input: TokenCountInput): TokenCountResult | null {
  if (!loadNative()) return null;
  try {
    // string[]：逐元素走同一护栏再求和（token 计数按文本段可加），
    // 不再整组透传 native——否则数组元素本身超长仍触雷。
    let count = 0;
    for (const item of Array.isArray(input.text) ? input.text : [input.text]) {
      count += countTextChunked(item, input.model);
    }
    return { count };
  } catch {
    return null;
  }
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
    return normalizeGrepResult(await native.grep(toNativeGrepOptions(options)));
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
  options?: { ignore_case?: boolean; multiline?: boolean; context?: number; max_count?: number },
): NativeGrepMatch[] | null {
  const native = loadNative();
  if (!native) return null;

  try {
    const result = native.search(content, toNativeSearchOptions(pattern, options));
    return Array.isArray(result.matches) ? result.matches.map(normalizeGrepMatch) : [];
  } catch {
    return null;
  }
}

export function nativeHasMatch(
  content: string,
  pattern: string,
  options?: { ignore_case?: boolean; multiline?: boolean },
): boolean | null {
  const native = loadNative();
  if (!native) return null;

  try {
    return native.hasMatch(
      content,
      pattern,
      options?.ignore_case,
      options?.multiline,
    );
  } catch {
    return null;
  }
}

/** Analyze a shell command only when the bundled native module supports it. */
export function nativeAnalyzeBash(command: string): NativeBashAnalysis | null {
  const native = loadNative();
  if (!native?.analyzeBash) return null;
  try {
    return native.analyzeBash(command);
  } catch {
    return null;
  }
}

export const hasMatch = nativeHasMatch;

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
    return normalizeGlobResult(await native.glob(toNativeGlobOptions(options)));
  } catch {
    return null;
  }
}

// ── Workspace Scan ───────────────────────────────────

/**
 * Native bounded workspace tree scan. Returns null if native unavailable.
 */
export async function nativeListWorkspace(
  options: NativeListWorkspaceOptions,
): Promise<NativeListWorkspaceResult | null> {
  const native = loadNative();
  if (!native) return null;

  try {
    return normalizeWorkspaceResult(
      await native.listWorkspace(toNativeListWorkspaceOptions(options)),
    );
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
    const result = await native.fuzzyFind(toNativeFuzzyFindOptions(query, searchPath, maxResults));
    if (!Array.isArray(result.matches)) return [];
    return result.matches.map((match: any) => ({
      path: String(match.path ?? ""),
      is_directory: Boolean(match.is_directory ?? match.isDirectory),
      score: Number(match.score ?? 0),
    }));
  } catch {
    return null;
  }
}

export function invalidateFsScanCache(path?: string): boolean {
  const native = loadNative();
  if (!native) return false;

  try {
    native.invalidateFsScanCache(path);
    return true;
  } catch {
    return false;
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
    // napi-derive maps Rust snake_case fields to camelCase at the FFI boundary;
    // passing snake_case keys through silently dropped every threshold (#239).
    return native.summarize({
      code: options.code,
      lang: options.lang,
      path: options.path,
      minBodyLines: options.min_body_lines,
      minCommentLines: options.min_comment_lines,
      unfoldUntilLines: options.unfold_until_lines,
      unfoldLimitLines: options.unfold_limit_lines,
    });
  } catch {
    return null;
  }
}
