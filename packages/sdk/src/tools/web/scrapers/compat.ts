import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { loadBinary as lumeLoadBinary, loadPage as lumeLoadPage, type FetchImpl } from "../../web-fetch-http.js";

export type AgentStorage = unknown;
export type HTMLElement = globalThis.HTMLElement;

export function parseHTML(html: string): { document: Document } {
  return new JSDOM(html).window;
}

export interface ScraperRuntime {
  fetchImpl: FetchImpl;
  sandbox?: import("../../../types.js").SandboxSettings;
  storage?: AgentStorage | null;
}

// Per-request runtime store: a module-level variable would race when the main
// agent and parallel subagents run web-fetch concurrently in one process (one
// finishing clears the runtime the other still needs), so scope it per async
// call chain instead.
const scraperRuntimeStore = new AsyncLocalStorage<ScraperRuntime>();

export function runWithScraperRuntime<T>(runtime: ScraperRuntime, fn: () => Promise<T>): Promise<T> {
  return scraperRuntimeStore.run(runtime, fn);
}

export function getScraperRuntime(): ScraperRuntime | undefined {
  return scraperRuntimeStore.getStore();
}

export function getRuntimeFetch(): FetchImpl {
  const runtime = scraperRuntimeStore.getStore();
  const implementation = runtime?.fetchImpl ?? fetch;
  return async (input, init = {}) => {
    const target = input;
    const signal = init.signal ?? undefined;
    const headers = new Headers();
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const result = await lumeLoadBinary(target, {
      fetchImpl: implementation,
      timeoutMs: 30_000,
      maxBytes: 50 * 1024 * 1024,
      headers: Object.fromEntries(headers.entries()),
      signal,
      sandbox: runtime?.sandbox,
    });
    if (!result.ok) return new Response(result.error ?? "request failed", { status: result.status || 599, headers: result.headers });
    return new Response(Buffer.from(result.bytes), { status: result.status, headers: result.headers });
  };
}

export function tryParseJson<T = unknown>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFrontmatter(content: string, _options?: { source?: string }): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }
  return { frontmatter, body: match[2] ?? "" };
}

export const $env = process.env as Record<string, string | undefined>;

function combineSignals(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  // Don't hold the process open for an idle timeout slot; it self-clears on fire.
  (timer as { unref?: () => void }).unref?.();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  // Callers must dispose once the request settles: without it the parent keeps
  // one listener per sub-request forever (paginated fetches tripped Node's
  // MaxListeners warning) and the timer spins to its deadline (#237).
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export const ptree = {
  combineSignals,
  async exec(args: unknown[], options: any = {}): Promise<any> {
    const [command, ...argv] = args as string[];
    if (!command) return { ok: false, code: 1, stdout: "", stderr: "missing command" };
    try {
      const result = await execFileAsync(command, argv, {
        signal: options.signal,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { ok: true, code: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error: any) {
      return { ok: false, code: Number(error?.code) || 1, stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? "") };
    }
  },
};

export const Snowflake = { next: () => `${Date.now()}-${Math.random().toString(36).slice(2)}` };

export class ToolAbortError extends Error {
  constructor() {
    super("Operation aborted");
    this.name = "ToolAbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ToolAbortError();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`;
}

export const settings = { get: (..._args: unknown[]) => "auto" as const };
const execFileAsync = promisify(execFile);
export async function ensureTool(name: string, _options?: unknown): Promise<string | null> {
  try {
    const command = process.platform === "win32" ? "where.exe" : "which";
    const result = await execFileAsync(command, [name], { windowsHide: true });
    return String(result.stdout).split(/\r?\n/).find(Boolean)?.trim() ?? null;
  } catch {
    return null;
  }
}
export function findParallelApiKey(..._args: unknown[]): string | undefined { return process.env.PARALLEL_API_KEY; }
export async function extractWithParallel(urls: string[], options: any = {}, _storage?: AgentStorage | null): Promise<any> {
  const apiKey = findParallelApiKey();
  if (!apiKey) throw new Error("Parallel credentials not found");
  const result = await runtimeLoadPage("https://api.parallel.ai/v1beta/extract", {
    timeout: 30,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "parallel-beta": "search-extract-2025-10-10",
    },
    body: JSON.stringify({
      urls,
      objective: options.objective,
      search_queries: options.searchQueries,
      excerpts: options.excerpts ?? true,
      full_content: options.fullContent ?? false,
    }),
    signal: options.signal,
  });
  if (!result.ok) throw new Error(`Parallel API error (${result.status ?? 0})`);
  const payload = tryParseJson<any>(result.content);
  if (!payload || typeof payload !== "object") throw new Error("Parallel extract returned invalid response");
  return {
    requestId: payload.extract_id ?? "",
    results: Array.isArray(payload.results) ? payload.results : [],
    errors: Array.isArray(payload.errors) ? payload.errors : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    usage: Array.isArray(payload.usage) ? payload.usage : [],
  };
}
export function getParallelExtractContent(document: any): string {
  const excerpts = Array.isArray(document?.excerpts) ? document.excerpts.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0) : [];
  return excerpts.join("\n\n").trim() || (typeof document?.fullContent === "string" ? document.fullContent.trim() : "");
}

export function getDocsRsCacheDir(): string {
  return join(tmpdir(), "lume-docsrs");
}

export function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export const logger = { warn: (..._args: unknown[]) => undefined };

export async function runtimeLoadPage(url: string, options: {
  timeout?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  maxBytes?: number;
  signal?: AbortSignal;
} = {}) {
  const runtime = scraperRuntimeStore.getStore();
  return lumeLoadPage(url, {
    fetchImpl: runtime?.fetchImpl ?? fetch,
    timeoutMs: Math.max(1, Math.round((options.timeout ?? 20) * 1000)),
    maxBytes: options.maxBytes,
    headers: options.headers,
    method: options.method,
    body: options.body,
    signal: options.signal,
    sandbox: runtime?.sandbox,
  });
}

export async function runtimeLoadBinary(url: string, options: { timeout?: number; maxBytes?: number; signal?: AbortSignal } = {}) {
  const runtime = scraperRuntimeStore.getStore();
  return lumeLoadBinary(url, {
    fetchImpl: runtime?.fetchImpl ?? fetch,
    timeoutMs: Math.max(1, Math.round((options.timeout ?? 20) * 1000)),
    maxBytes: options.maxBytes,
    signal: options.signal,
    sandbox: runtime?.sandbox,
  });
}
