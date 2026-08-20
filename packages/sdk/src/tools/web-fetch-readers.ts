import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SandboxSettings, ToolContext } from "../types.js";
import { ensureNetworkAllowed } from "../utils/pathing.js";
import { extractArticleMarkdown } from "./html-to-markdown.js";
import { loadPage, type FetchImpl } from "./web-fetch-http.js";

const execFileAsync = promisify(execFile);

export type ReaderPreference = "auto" | "native" | "trafilatura" | "lynx" | "parallel" | "jina";

export interface ReaderContext {
  url: string;
  html: string;
  timeoutMs: number;
  signal?: AbortSignal;
  sandbox?: SandboxSettings;
  fetchImpl: FetchImpl;
  toolContext: ToolContext;
}

export interface ReaderResult {
  title: string;
  content: string;
  method: ReaderPreference;
}

const ORDER: readonly ReaderPreference[] = ["native", "trafilatura", "lynx", "parallel", "jina"];

function isLowQualityOutput(content: string): boolean {
  const lower = content.toLowerCase();
  if (content.length < 1024 && [
    "enable javascript",
    "javascript required",
    "turn on javascript",
    "please enable javascript",
    "browser not supported",
  ].some(marker => lower.includes(marker))) return true;
  const lines = content.split("\n").filter(line => line.trim());
  const shortLines = lines.filter(line => line.trim().length < 40);
  if (lines.length > 10 && shortLines.length / lines.length > 0.7) return true;
  const navigationLines = lines.filter(line => /^(home|menu|search|sign in|log in|subscribe|privacy|terms|next|previous)\b/i.test(line.trim()));
  return lines.length > 12 && navigationLines.length / lines.length > 0.45;
}

function usable(content: string | null | undefined): content is string {
  return Boolean(content && content.trim().length > 100 && !isLowQualityOutput(content));
}

function configuredReader(context: ToolContext): Record<string, unknown> {
  const value = context.toolConfig?.webFetch;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function providerOrder(preference: ReaderPreference): readonly ReaderPreference[] {
  return preference === "auto" ? ORDER : [preference, ...ORDER.filter(method => method !== preference)];
}

async function runCommand(command: string, args: string[], context: ReaderContext): Promise<string | null> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: Math.min(context.timeoutMs, 10000),
      signal: context.signal,
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

async function runParallel(context: ReaderContext, configuredApiKey?: string): Promise<string | null> {
  const apiKey = configuredApiKey || process.env.PARALLEL_API_KEY;
  // The proxy fetches context.url on our behalf — the target itself must pass
  // the domain whitelist, not just the proxy host (#200)
  if (!apiKey || ensureNetworkAllowed(context.url, context.sandbox) || ensureNetworkAllowed("https://api.parallel.ai", context.sandbox)) return null;
  const requestSignal = context.signal ?? AbortSignal.timeout(Math.min(context.timeoutMs, 10000));
  const response = await context.fetchImpl("https://api.parallel.ai/v1beta/extract", {
    method: "POST",
    redirect: "manual",
    signal: requestSignal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "parallel-beta": "search-extract-2025-10-10",
    },
    body: JSON.stringify({
      urls: [context.url],
      objective: "Extract the main content",
      excerpts: true,
      full_content: false,
    }),
  });
  if (!response.ok || response.status >= 300 && response.status < 400) return null;
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > 5 * 1024 * 1024) return null;
  const raw = await response.arrayBuffer();
  if (raw.byteLength > 5 * 1024 * 1024) return null;
  const payload = JSON.parse(new TextDecoder().decode(raw)) as { results?: Array<{ excerpts?: string[]; full_content?: string }> };
  const first = payload.results?.[0];
  return first?.excerpts?.join("\n\n") || first?.full_content || null;
}

async function runJina(context: ReaderContext, configuredApiKey?: string): Promise<string | null> {
  const endpoint = `https://r.jina.ai/${context.url}`;
  // Check the target URL too: r.jina.ai fetches it server-side (#200)
  if (ensureNetworkAllowed(context.url, context.sandbox) || ensureNetworkAllowed(endpoint, context.sandbox)) return null;
  const headers: Record<string, string> = { Accept: "text/markdown" };
  const apiKey = configuredApiKey || process.env.JINA_API_KEY;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const result = await loadPage(endpoint, {
    timeoutMs: Math.min(context.timeoutMs, 10000),
    headers,
    signal: context.signal,
    sandbox: context.sandbox,
    fetchImpl: context.fetchImpl,
  });
  return result.ok ? result.content : null;
}

export async function renderHtmlToMarkdown(
  context: ReaderContext,
  preference: ReaderPreference,
): Promise<ReaderResult | null> {
  const configured = configuredReader(context.toolContext);
  const order = providerOrder(preference);
  for (const method of order) {
    if (context.signal?.aborted) throw new Error("request aborted");
    try {
      let content: string | null = null;
      let title = "";
      if (method === "native") {
        const article = extractArticleMarkdown(context.html, context.url);
        content = article?.content ?? null;
        title = article?.title ?? "";
      } else if (method === "trafilatura") {
        content = await runCommand("trafilatura", ["-u", context.url, "--output-format", "markdown"], context);
      } else if (method === "lynx") {
        content = await runCommand("lynx", ["-dump", "-nolist", "-width", "250", context.url], context);
      } else if (method === "parallel") {
        if (preference === "auto" && typeof configured.parallelApiKey !== "string" && !process.env.PARALLEL_API_KEY) continue;
        content = await runParallel(context, typeof configured.parallelApiKey === "string" ? configured.parallelApiKey : undefined);
      } else if (method === "jina") {
        if (preference === "auto" && typeof configured.jinaApiKey !== "string" && !process.env.JINA_API_KEY) continue;
        content = await runJina(context, typeof configured.jinaApiKey === "string" ? configured.jinaApiKey : undefined);
      }
      if (usable(content)) return { title, content: content.trim(), method };
    } catch {
      // A reader is deliberately best-effort; the next reader or raw fallback wins.
    }
  }
  return null;
}

export function isLowQualityReaderOutput(content: string): boolean {
  return isLowQualityOutput(content);
}
