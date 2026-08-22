import { XMLParser } from "fast-xml-parser";
import { defineTool } from "./types.js";
import type { ToolContext, ToolResultContentBlock } from "../types.js";
import { ensureNetworkAllowed } from "../utils/pathing.js";
import { sdkFetch } from "./web-request.js";
import { extractArticleMarkdown } from "./html-to-markdown.js";
import { shouldRender, type RenderMode } from "./render-judge.js";
import { downloadAndLocalizeImages, type ImageMode } from "./image-pipeline.js";
import { buildAssetFile } from "./asset-markdown.js";
import { createNoopRenderClient, type RenderClient } from "./render-client.js";
import {
  loadPage,
  loadBinary,
  MAX_FETCH_BYTES,
  type FetchImpl,
} from "./web-fetch-http.js";
import { renderHtmlToMarkdown, type ReaderPreference } from "./web-fetch-readers.js";
import { contentKind, renderStructuredBinary } from "./web-fetch-content.js";

const MAX_FETCH_CHARS = 100000;
const MAX_RAW_HTML_CHARS = 10_000_000;
const DEFAULT_TIMEOUT_MS = 30000;
const XML = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export interface WebFetchInput {
  url: string;
  format?: "markdown" | "text" | "html";
  render?: RenderMode;
  images?: ImageMode;
  reader?: ReaderPreference;
}

export interface WebFetchDeps {
  renderClient?: RenderClient;
  resolveAssetDir?: (url: string) => string | null | undefined;
  fetchImpl?: FetchImpl;
}

interface RenderedContent {
  title: string;
  markdown: string;
  method: string;
  finalUrl?: string;
  notes?: string[];
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("URL is required");
  const explicitScheme = /^https?:\/\//i.test(trimmed);
  if (!explicitScheme && !trimmed.includes(".") && !/^localhost(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    throw new Error("URL must include a hostname");
  }
  const normalized = explicitScheme ? trimmed : `https://${trimmed}`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error("Only HTTP(S) URLs are supported");
  }
  return parsed.href;
}

function isHtmlResponse(contentType: string, content: string): boolean {
  return contentType.includes("html") || /^\s*(<!doctype|<html|<head|<body)/i.test(content);
}

function isFeedResponse(contentType: string, content: string): boolean {
  return /rss|atom|feed|xml/i.test(contentType) && /<(rss|feed|channel)\b/i.test(content);
}

function isImageResponse(contentType: string, url: string): boolean {
  if (contentType.startsWith("image/")) return true;
  try { return /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(new URL(url).pathname); } catch { return false; }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~-]/g, "")
    .replace(/^\s*\|.*$/gm, line => line.replace(/^\s*\|\s?/, "").replace(/\s?\|\s*$/, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function finalizeMarkdown(content: string): string {
  const normalized = content.replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > MAX_FETCH_CHARS
    ? `${normalized.slice(0, MAX_FETCH_CHARS)}\n\n[content truncated]`
    : normalized;
}

function extractHead(html: string): string {
  const lower = html.toLowerCase();
  const start = lower.indexOf("<head");
  if (start < 0) return html.slice(0, 32768);
  const tagEnd = html.indexOf(">", start);
  if (tagEnd < 0) return html.slice(start, start + 32768);
  const end = lower.indexOf("</head>", tagEnd + 1);
  return html.slice(start, end < 0 ? tagEnd + 32768 : end + 7);
}

function alternateLinks(html: string, pageUrl: string): string[] {
  const links: string[] = [];
  const tags = extractHead(html).match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const rel = /\brel\s*=\s*["']([^"']*)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!rel.split(/\s+/).includes("alternate")) continue;
    const href = /\bhref\s*=\s*["']([^"']*)/i.exec(tag)?.[1];
    const type = /\btype\s*=\s*["']([^"']*)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!href || (!type.includes("markdown") && !type.includes("rss") && !type.includes("atom") && !type.includes("feed"))) continue;
    try { links.push(new URL(href, pageUrl).href); } catch { /* malformed alternate */ }
  }
  return links;
}

function llmCandidates(url: string): string[] {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path === "") return [`${parsed.origin}/.well-known/llms.txt`, `${parsed.origin}/llms.txt`, `${parsed.origin}/llms.md`];
    const segments = path.split("/").filter(Boolean);
    const depth = parsed.pathname.endsWith("/") ? segments.length : Math.max(1, segments.length - 1);
    const result: string[] = [];
    for (let i = depth; i >= 1; i--) {
      const scope = `/${segments.slice(0, i).join("/")}/`;
      result.push(`${parsed.origin}${scope}llms.txt`, `${parsed.origin}${scope}llms.md`);
    }
    return result;
  } catch {
    return [];
  }
}

function markdownCandidates(url: string): string[] {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (/\.md$/i.test(path)) return [];
    const base = path.endsWith("/") ? `${path}index` : path;
    return [`${parsed.origin}${base}.md`];
  } catch {
    return [];
  }
}

async function fetchTextCandidate(
  url: string,
  context: { signal?: AbortSignal; sandbox?: ToolContext["sandbox"]; fetchImpl: FetchImpl; timeoutMs: number },
  headers?: Record<string, string>,
): Promise<{ content: string; finalUrl: string; contentType: string } | null> {
  if (ensureNetworkAllowed(url, context.sandbox)) return null;
  const result = await loadPage(url, {
    timeoutMs: context.timeoutMs,
    maxBytes: MAX_FETCH_BYTES,
    headers,
    signal: context.signal,
    sandbox: context.sandbox,
    fetchImpl: context.fetchImpl,
  });
  return result.ok ? { content: result.content, finalUrl: result.finalUrl, contentType: result.contentType } : null;
}

async function parseFeed(content: string): Promise<string | null> {
  try {
    const root = XML.parse(content);
    const channel = root.rss?.channel ?? root.feed;
    const rawItems = channel?.item ?? channel?.entry;
    const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
    if (items.length === 0) return null;
    const lines = ["# Feed", ""];
    for (const item of items.slice(0, 20) as Array<Record<string, unknown>>) {
      const title = String(item.title ?? "Untitled").trim();
      const linkValue = item.link;
      const link = typeof linkValue === "string"
        ? linkValue
        : linkValue && typeof linkValue === "object" ? String((linkValue as Record<string, unknown>)["@_href"] ?? "") : "";
      const description = String(item.description ?? item.summary ?? item.content ?? "").trim();
      lines.push(`## ${title}`, "", link ? `[Open article](${link})` : "", description, "");
    }
    return lines.join("\n").trim();
  } catch {
    return null;
  }
}

async function renderGenericHtml(
  html: string,
  url: string,
  context: ToolContext,
  fetchImpl: FetchImpl,
  preference: ReaderPreference,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RenderedContent | null> {
  const alternates = alternateLinks(html, url);
  for (const candidate of alternates) {
    const result = await fetchTextCandidate(candidate, {
      signal,
      sandbox: context.sandbox,
      fetchImpl,
      timeoutMs: Math.min(timeoutMs, 10000),
    });
    if (!result || result.content.trim().length < 100 || isHtmlResponse(result.contentType, result.content)) continue;
    if (/rss|atom|feed|xml/i.test(result.contentType)) {
      const feed = await parseFeed(result.content);
      if (feed) return { title: "", markdown: feed, method: "alternate-feed", finalUrl: result.finalUrl };
    } else if (/markdown|text\/plain/i.test(result.contentType) || candidate.endsWith(".md")) {
      return { title: "", markdown: result.content, method: "alternate-markdown", finalUrl: result.finalUrl };
    }
  }

  for (const candidate of markdownCandidates(url)) {
    const result = await fetchTextCandidate(candidate, {
      signal,
      sandbox: context.sandbox,
      fetchImpl,
      timeoutMs: Math.min(timeoutMs, 10000),
      }, { Accept: "text/markdown, text/plain;q=0.9" });
    if (result && result.content.trim().length > 100 && !isHtmlResponse(result.contentType, result.content)) {
      return { title: "", markdown: result.content, method: "url-markdown", finalUrl: result.finalUrl };
    }
  }

  const negotiated = await fetchTextCandidate(url, {
    signal,
    sandbox: context.sandbox,
    fetchImpl,
    timeoutMs: Math.min(timeoutMs, 10000),
  }, { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" });
  if (negotiated && negotiated.content.trim().length > 100 && !isHtmlResponse(negotiated.contentType, negotiated.content)) {
    if (/rss|atom|feed|xml/i.test(negotiated.contentType)) {
      const feed = await parseFeed(negotiated.content);
      if (feed) return { title: "", markdown: feed, method: "negotiated-feed", finalUrl: negotiated.finalUrl };
    } else {
      return { title: "", markdown: negotiated.content, method: "content-negotiation", finalUrl: negotiated.finalUrl };
    }
  }

  const readerResult = await renderHtmlToMarkdown({
    url,
    html,
    timeoutMs,
    signal,
    sandbox: context.sandbox,
    fetchImpl,
    toolContext: context,
  }, preference);
  if (readerResult) return {
    title: readerResult.title,
    markdown: readerResult.content,
    method: readerResult.method,
  };

  for (const candidate of llmCandidates(url)) {
    const result = await fetchTextCandidate(candidate, {
      signal,
      sandbox: context.sandbox,
      fetchImpl,
      timeoutMs: Math.min(timeoutMs, 5000),
    });
    if (result && result.content.trim().length > 100 && !isHtmlResponse(result.contentType, result.content)) {
      return { title: "", markdown: result.content, method: "llms.txt", finalUrl: result.finalUrl };
    }
  }

  const article = extractArticleMarkdown(html, url);
  if (article) return { title: article.title, markdown: article.content, method: "native-low-quality" };
  return null;
}

export async function runWebFetch(
  input: WebFetchInput,
  context: ToolContext,
  deps: WebFetchDeps = {},
): Promise<{ data: unknown; is_error?: boolean }> {
  let requestedUrl: string;
  try {
    requestedUrl = normalizeUrl(input.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { data: `Error fetching ${input.url}: ${message}`, is_error: true };
  }
  const format = input.format === "text" || input.format === "html" ? input.format : "markdown";
  const renderMode: RenderMode = input.render ?? "auto";
  const imageMode: ImageMode = input.images ?? "download";
  const readerPreference: ReaderPreference = input.reader ?? readConfiguredReader(context);
  const fetchImpl = deps.fetchImpl ?? sdkFetch;
  const renderClient = deps.renderClient ?? createNoopRenderClient();
  const timeoutMs = readTimeout(context);

  const sandboxError = ensureNetworkAllowed(requestedUrl, context.sandbox);
  if (sandboxError) return { data: sandboxError, is_error: true };

  try {
    if (format !== "html") {
      const { handleSpecialUrl } = await import("./web/scrapers/index.js");
      const special = await handleSpecialUrl(requestedUrl, {
        timeoutMs,
        signal: context.abortSignal,
        sandbox: context.sandbox,
        fetchImpl,
      });
      if (special?.content) {
        const specialMarkdown = format === "text" ? stripMarkdown(special.content) : special.content;
        const notes = special.notes.length > 0 ? `Notes: ${special.notes.join("; ")}\n` : "";
        const header = `URL: ${special.finalUrl}\nContent-Type: ${special.contentType}\nMethod: ${special.method}\n${notes}`;
        return { data: `${header}\n---\n\n${finalizeMarkdown(specialMarkdown)}` };
      }
    }
    const response = await loadPage(requestedUrl, {
      timeoutMs,
      maxBytes: MAX_FETCH_BYTES,
      signal: context.abortSignal,
      sandbox: context.sandbox,
      fetchImpl,
    });
    if (!response.ok) {
      return { data: response.error ? `${response.error} (HTTP ${response.status || "request"})` : `HTTP ${response.status}`, is_error: true };
    }
    let rawContent = response.content;
    if (rawContent.length > MAX_RAW_HTML_CHARS) rawContent = rawContent.slice(0, MAX_RAW_HTML_CHARS);
    let finalUrl = response.finalUrl || requestedUrl;

    if (!isHtmlResponse(response.contentType, rawContent)) {
      if (isImageResponse(response.contentType, finalUrl)) {
        const binary = await loadBinary(finalUrl, {
          fetchImpl,
          maxBytes: 20 * 1024 * 1024,
          timeoutMs,
          signal: context.abortSignal,
          sandbox: context.sandbox,
        });
        if (!binary.ok || binary.error) {
          return { data: `Image fetch failed: ${binary.error || `HTTP ${binary.status}`}\nURL: ${finalUrl}`, is_error: true };
        }
        const image: ToolResultContentBlock = {
          type: "image",
          data: Buffer.from(binary.bytes).toString("base64"),
          mimeType: binary.contentType || response.contentType || "application/octet-stream",
        };
        return { data: { content: [image] } };
      }
      const structuredKind = contentKind(response.contentType, finalUrl);
      if (structuredKind) {
        const binary = await loadBinary(finalUrl, {
          fetchImpl,
          maxBytes: MAX_FETCH_BYTES,
          timeoutMs,
          signal: context.abortSignal,
          sandbox: context.sandbox,
        });
        if (binary.ok && !binary.error) {
          const structured = await renderStructuredBinary(binary.bytes, binary.contentType || response.contentType, finalUrl);
          if (structured?.markdown) return { data: finalizeMarkdown(structured.markdown) };
        }
        return { data: `${structuredKind} resource (${response.contentType || "unknown MIME"}, ${rawContent.length} bytes)\nURL: ${finalUrl}`, is_error: true };
      }
      if (isFeedResponse(response.contentType, rawContent)) {
        const feed = await parseFeed(rawContent);
        return { data: finalizeMarkdown(feed ?? rawContent) };
      }
      if (response.contentType.includes("json")) {
        try { return { data: finalizeMarkdown(JSON.stringify(JSON.parse(rawContent), null, 2)) }; } catch { /* return source */ }
      }
      return { data: finalizeMarkdown(rawContent || "(empty response)") };
    }
    if (format === "html") return { data: finalizeMarkdown(rawContent) };

    let finalHtml = rawContent;
    let renderNote = "";
    if (shouldRender(rawContent, renderMode)) {
      const rendered = await renderClient.renderUrl(finalUrl, { timeoutMs: Math.min(45000, timeoutMs) });
      if (rendered.ok === true) {
        if (!ensureNetworkAllowed(rendered.finalUrl, context.sandbox)) {
          finalHtml = rendered.html.slice(0, MAX_RAW_HTML_CHARS);
          finalUrl = rendered.finalUrl || finalUrl;
        } else {
          renderNote = "\n\n[render failed: sandbox denied final URL; static fallback]";
        }
      } else {
        renderNote = `\n\n[render failed: ${rendered.error.code}; static fallback]`;
      }
    }

    const assetDir = deps.resolveAssetDir?.(requestedUrl) ?? null;
    const effectiveImageMode: ImageMode = assetDir ? imageMode : imageMode === "download" ? "keep" : imageMode;
    const localized = await downloadAndLocalizeImages(
      finalHtml,
      finalUrl,
      assetDir ? `${assetDir}/images`.replace(/\\/g, "/") : "/tmp/lume-none",
      effectiveImageMode,
      fetchImpl,
      context.sandbox,
    );

    const markdownResult = await renderGenericHtml(
      localized.html,
      finalUrl,
      context,
      fetchImpl,
      readerPreference,
      context.abortSignal,
      timeoutMs,
    );
    const title = markdownResult?.title ?? "";
    let markdown = markdownResult?.markdown ?? cleanText(
      localized.html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " "),
    );
    if (isFeedResponse(response.contentType, rawContent)) markdown = (await parseFeed(rawContent)) ?? markdown;
    if (format === "text") markdown = stripMarkdown(markdown);
    markdown = finalizeMarkdown(markdown || "(empty response)");

    let assetDirNote = "";
    if (assetDir) {
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        await fs.mkdir(assetDir, { recursive: true });
        const file = buildAssetFile({ source: requestedUrl, fetchedAt: new Date().toISOString(), title: title || undefined, markdown: `${title ? `# ${title}\n\n` : ""}${markdown}` });
        await fs.writeFile(path.join(assetDir, "index.md"), file, "utf8");
        assetDirNote = `\n\n[Asset: ${assetDir}]`;
      } catch {
        assetDirNote = "\n\n[Asset write failed; content returned]";
      }
    }

    const prefix = title && !markdown.startsWith(`# ${title}`) ? `# ${title}\n\n` : "";
    const methodNote = markdownResult ? `\n\n[reader: ${markdownResult.method}]` : "";
    return { data: `${prefix}${markdown}${methodNote}${renderNote}${assetDirNote}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { data: `Error fetching ${requestedUrl}: ${message}`, is_error: true };
  }
}

function readConfiguredReader(context: ToolContext): ReaderPreference {
  const config = context.toolConfig?.webFetch;
  if (config && typeof config === "object" && !Array.isArray(config)) {
    const reader = (config as Record<string, unknown>).reader;
    if (reader === "native" || reader === "trafilatura" || reader === "lynx" || reader === "parallel" || reader === "jina") return reader;
  }
  return "auto";
}

function readTimeout(context: ToolContext): number {
  const value = context.toolConfig?.webFetch;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const timeoutMs = (value as Record<string, unknown>).timeoutMs;
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) return Math.min(Math.max(timeoutMs, 1000), 120000);
  }
  return DEFAULT_TIMEOUT_MS;
}

export const WebFetchTool = defineTool({
  name: "WebFetch",
  description:
    "Fetch content from a URL and return it as Markdown. Supports GFM tables, reader fallbacks, JS-rendered pages, structured site handlers, documents, images, feeds, and archives.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch content from" },
      format: { type: "string", enum: ["markdown", "text", "html"], description: "Output format. Default: markdown" },
      render: { type: "string", enum: ["auto", "force", "off"], description: "JS render mode. Default: auto" },
      images: { type: "string", enum: ["download", "keep", "off"], description: "Image handling. Default: download" },
      reader: { type: "string", enum: ["auto", "native", "trafilatura", "lynx", "parallel", "jina"], description: "Reader backend preference. Default: auto" },
    },
    required: ["url"],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    return runWebFetch(input as WebFetchInput, context);
  },
});
