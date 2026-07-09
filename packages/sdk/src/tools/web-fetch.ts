/**
 * WebFetchTool - Fetch web content, optional JS-render fallback + image/asset localization.
 */
import { defineTool } from "./types.js";
import type { ToolContext } from "../types.js";
import { ensureNetworkAllowed } from "../utils/pathing.js";
import { sdkFetch } from "./web-request.js";
import { extractArticleMarkdown } from "./html-to-markdown.js";
import { shouldRender, type RenderMode } from "./render-judge.js";
import { downloadAndLocalizeImages, type ImageMode } from "./image-pipeline.js";
import { buildAssetFile } from "./asset-markdown.js";
import { createNoopRenderClient, type RenderClient } from "./render-client.js";

const MAX_FETCH_CHARS = 100000;

export interface WebFetchInput {
  url: string;
  format?: "markdown" | "text" | "html";
  render?: RenderMode;
  images?: ImageMode;
}

export interface WebFetchDeps {
  renderClient?: RenderClient;
  /** Returns absolute asset dir for a URL, or null/undefined to skip persistence. */
  resolveAssetDir?: (url: string) => string | null | undefined;
  /** Override fetch (testing). Defaults to sdkFetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export async function runWebFetch(
  input: WebFetchInput,
  context: ToolContext,
  deps: WebFetchDeps = {},
): Promise<{ data: string; is_error?: boolean }> {
  const { url } = input;
  const format = input.format === "text" || input.format === "html" ? input.format : "markdown";
  const renderMode: RenderMode = input.render ?? "auto";
  const imageMode: ImageMode = input.images ?? "download";
  const fetchImpl = deps.fetchImpl ?? sdkFetch;
  const renderClient = deps.renderClient ?? createNoopRenderClient();

  const sandboxError = ensureNetworkAllowed(url, context.sandbox);
  if (sandboxError) return { data: sandboxError, is_error: true };

  try {
    const response = await fetchImpl(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return { data: `HTTP ${response.status}: ${response.statusText}`, is_error: true };

    const contentType = response.headers.get("content-type") || "";
    let rawHtml = await response.text();
    if (rawHtml.length > MAX_FETCH_CHARS) rawHtml = rawHtml.slice(0, MAX_FETCH_CHARS);

    const isHtml = contentType.includes("text/html") || rawHtml.trimStart().startsWith("<");
    if (!isHtml) return { data: rawHtml || "(empty response)" };
    if (format === "html") return { data: rawHtml };

    // decide finalHtml: static or rendered
    let finalHtml = rawHtml;
    let renderNote = "";
    if (shouldRender(rawHtml, renderMode)) {
      const r = await renderClient.renderUrl(url, { timeoutMs: 45000 });
      if (r.ok) {
        finalHtml = r.html.length > MAX_FETCH_CHARS ? r.html.slice(0, MAX_FETCH_CHARS) : r.html;
      } else {
        renderNote = `\n\n[render failed: ${r.error.code}; static fallback]`;
      }
    }

    // image localization BEFORE Readability/Turndown
    let assetDirNote = "";
    const assetDir = deps.resolveAssetDir?.(url) ?? null;
    const effectiveImageMode: ImageMode = assetDir ? imageMode : imageMode === "download" ? "keep" : imageMode;
    const imagesDir = assetDir ? `${assetDir}/images`.replace(/\\/g, "/") : "/tmp/lume-none";
    const localized = await downloadAndLocalizeImages(finalHtml, url, imagesDir, effectiveImageMode, fetchImpl);

    const article = await extractReadableArticleMarkdown(localized.html, url);
    const title = article?.title || "";
    let markdown: string;
    if (article) {
      markdown = format === "text"
        ? article.content.replace(/[#*_`>\[\]()!-]/g, "")
        : article.content;
    } else {
      const stripped = localized.html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      markdown = stripped || "(empty response)";
    }

    // asset persistence
    if (assetDir) {
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        await fs.mkdir(assetDir, { recursive: true });
        const fetchedAt = new Date().toISOString();
        const file = buildAssetFile({ source: url, fetchedAt, title: title || undefined, markdown: `# ${title}\n\n${markdown}` });
        await fs.writeFile(path.join(assetDir, "index.md"), file, "utf8");
        assetDirNote = `\n\n[Asset: ${assetDir}]`;
      } catch {
        assetDirNote = `\n\n[Asset write failed; content returned]`;
      }
    }

    const prefix = title ? `# ${title}\n\n` : "";
    return { data: `${prefix}${markdown}${renderNote}${assetDirNote}` };
  } catch (err: any) {
    return { data: `Error fetching ${url}: ${err.message}`, is_error: true };
  }
}

async function extractReadableArticleMarkdown(
  html: string,
  url: string,
): Promise<{ title: string; content: string } | null> {
  try {
    return extractArticleMarkdown(html, url);
  } catch {
    return null;
  }
}

export const WebFetchTool = defineTool({
  name: "WebFetch",
  description:
    "Fetch content from a URL and return it as Markdown. Strips boilerplate using Mozilla Readability. " +
    "Supports render (auto/force/off) for JS-rendered pages and images (download/keep/off) localization.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch content from" },
      format: { type: "string", enum: ["markdown", "text", "html"], description: "Output format. Default: markdown" },
      render: { type: "string", enum: ["auto", "force", "off"], description: "JS render mode. Default: auto" },
      images: { type: "string", enum: ["download", "keep", "off"], description: "Image handling. Default: download" },
    },
    required: ["url"],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    return runWebFetch(input as WebFetchInput, context);
  },
});
