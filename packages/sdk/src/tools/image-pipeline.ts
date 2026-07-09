// packages/sdk/src/tools/image-pipeline.ts
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { JSDOM } from "jsdom";

export type ImageMode = "download" | "keep" | "off";
type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** `lume-file://file/<encoded absolute path>` — matches apps/web lumeFileUrl. */
export function lumeFileUrl(absPath: string): string {
  return `lume-file://file/${encodeURIComponent(absPath)}`;
}

/** Stable 8-hex asset id from URL (sha256 prefix). */
export function fetchIdFromUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 8);
}

/** Resolve a usable image source, accounting for common lazy-load attrs. */
export function resolveImgSrc(el: HTMLImageElement): string | null {
  const ds = (el as HTMLImageElement & Record<string, string>).dataset;
  const candidates = [
    el.getAttribute("src") || undefined,
    ds.src,
    ds.original,
    ds.lazySrc,
    firstOfSrcset(el.getAttribute("srcset") || undefined),
  ];
  for (const c of candidates) {
    if (c && c.trim() && !isPlaceholder(c.trim())) return c.trim();
  }
  return null;
}

function firstOfSrcset(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  return srcset.split(",")[0]?.split(/\s+/)[0];
}

const PLACEHOLDERS = new Set(["", "data:,", "about:blank"]);
function isPlaceholder(src: string): boolean {
  if (PLACEHOLDERS.has(src)) return true;
  return src.startsWith("data:image/svg"); // common transparent placeholder
}

function sniffExt(contentType: string, url: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("svg")) return ".svg";
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  return fromUrl && /\.(png|jpe?g|webp|gif|svg)$/.test(fromUrl) ? fromUrl : ".png";
}

export interface LocalizeResult {
  html: string;
  downloaded: number;
  failed: number;
}

/**
 * Walk <img> in html: resolve lazy src, optionally download (Referer = page origin,
 * anti-hotlink), rewrite to lume-file:// local path. Runs BEFORE Readability/Turndown
 * so converted Markdown keeps working image links.
 */
export async function downloadAndLocalizeImages(
  html: string,
  pageUrl: string,
  imagesDir: string,
  mode: ImageMode,
  fetchImpl: FetchImpl,
): Promise<LocalizeResult> {
  if (mode === "off") return { html, downloaded: 0, failed: 0 };

  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const origin = (() => { try { return new URL(pageUrl).origin; } catch { return undefined; } })();

  let downloaded = 0;
  let failed = 0;

  if (mode === "download") {
    try { await mkdir(imagesDir, { recursive: true }); } catch { /* ignore */ }
  }

  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = resolveImgSrc(img as unknown as HTMLImageElement);
    if (!src) continue;
    let absUrl: string;
    try { absUrl = new URL(src, pageUrl).href; } catch { continue; }

    if (mode === "keep") {
      img.setAttribute("src", absUrl);
      img.removeAttribute("srcset");
      continue;
    }

    // mode === "download"
    try {
      const res = await fetchImpl(absUrl, {
        headers: {
          ...(origin ? { Referer: `${origin}/` } : {}),
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = sniffExt(res.headers.get("content-type") || "", absUrl);
      const name = createHash("sha256").update(buf).digest("hex").slice(0, 16) + ext;
      await writeFile(join(imagesDir, name), buf);
      img.setAttribute("src", lumeFileUrl(join(imagesDir, name)));
      img.removeAttribute("srcset");
      downloaded++;
    } catch {
      img.setAttribute("src", absUrl);
      img.setAttribute("data-fetch-error", "download_failed");
      failed++;
    }
  }

  return { html: doc.documentElement.outerHTML, downloaded, failed };
}
