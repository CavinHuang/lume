# WebFetch 增强：JS 渲染抓取 + 图片/资产本地化 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 `WebFetch` 工具，支持 JS 渲染页面抓取（复用 Electron `webContents`）、图片本地化（绕防盗链）与原文 Markdown 资产持久化。

**Architecture:** 分层抓取——默认静态管线，SPA 页经 sidecar→main reverse-RPC 回退到主进程隐藏 `webContents` 渲染；图片在 Turndown 前于 HTML 阶段下载本地化（`lume-file://` 引用）；原文 Markdown + 图片作为资产包写入 `agent-workspaces/<slug>/resources/fetches/<fetchId>/`。

**Tech Stack:** TypeScript (ESM)，Electron `webContents`/`BrowserWindow`，Node `node:crypto`，`@mozilla/readability` + `turndown` + `jsdom`（均已装），`bun:test`（SDK/sidecar）、`node:test` via `bun test`（desktop）。

**Spec:** `docs/superpowers/specs/2026-07-09-web-fetch-render-and-images-design.md`

## Global Constraints

- **提交策略（用户 2026-07-09 授权 per-task commit，同 lume-file/models.dev 模式）**：每个任务由 implementer 创建一个 commit，仅 `git add` 本任务新增/修改的文件（**不 add** 工作树里其他特性的未提交改动）；review 用 `review-package BASE HEAD`，BASE = dispatch implementer 前记录的 HEAD。`main.ts` 现有未提交改动接受叠加（T8/T10 改 main.ts 会与现有改动同 commit）。完成后由用户决定 push/合并。
- **零新运行时依赖**：hash 用 `node:crypto`（无包依赖）；不引入 Playwright/Puppeteer/Jina。
- **ESM + `.js` 导入扩展名**：所有相对 import 在 TS 源码中用 `.js`（如 `'./render-client.js'`）。
- **测试框架**：SDK 与 sidecar 用 `bun:test`（`import { describe, expect, test } from 'bun:test'`）；desktop 用 `node:test`（`import { test } from 'node:test'` + `node:assert/strict`）。运行命令统一在仓库根 `bun test <path>`。
- **lume-file URL 格式**：`lume-file://file/${encodeURIComponent(absPath)}`（与 `apps/web/.../file-preview-utils.ts:18-20` 一致）。
- **图片资产可信根**：`<getConfigDir()>/agent-workspaces`（`lume-file://` 白名单根，`resolveFileProtocolPath` 校验）。图片必须存其下才能在 UI 显示。
- **reverse-RPC 单一用途**：`render:request`/`render:result` 硬编码 method，不做通用 sidecar→main RPC 注册表。
- **设计文档 §11 细化**：reverse-RPC 客户端实现归 sidecar（依赖 transport），SDK 仅定义 `RenderClient` 接口 + noop 默认实现（`packages/sdk/src/tools/render-client.ts`）。

---

## File Structure

**SDK（`packages/sdk/src/tools/`）—— 纯函数 + 核心编排，可独立单测：**
- Create `render-client.ts` — `RenderClient` 接口、`RenderOutcome` 类型、`createNoopRenderClient()`（headless 降级）
- Create `image-pipeline.ts` — `resolveImgSrc`、`downloadAndLocalizeImages`、`lumeFileUrl`、`fetchIdFromUrl`
- Create `render-judge.ts` — `shouldRender` + `bodyTextLength`/`hasSpaShell`/`isErrorShell`
- Create `asset-markdown.ts` — `buildAssetFile`（frontmatter + 正文）
- Modify `web-fetch.ts` — 抽 `runWebFetch(input, context, deps)`；`WebFetchTool` 默认纯静态（向后兼容）；导出 `runWebFetch`
- Create `web-fetch-enhanced.test.ts` — runWebFetch 编排测试（mock renderClient + fetch）

**Sidecar（`apps/sidecar/src/`）：**
- Create `services/agent-runtime/tools/web/reverse-rpc-render-client.ts` — `createReverseRpcRenderClient`（pending + renderUrl + handleRenderResult）
- Modify `services/agent-runtime/tools/web/create-web-tools.ts` — `createSdkWebTools({workspaceSlug, renderClient})`，包装增强 WebFetch
- Modify `rpc/create-rpc-handlers.ts` — 注册 `render:result` handler
- Modify `services/agent-runtime/runtime-core/run.ts`（或装配点）— 把 renderClient + workspaceSlug 传入 createSdkWebTools
- Create `services/agent-runtime/tools/web/reverse-rpc-render-client.test.ts` — FakeParentPort 契约测试

**Desktop（`apps/desktop/src/`）：**
- Create `page-renderer.ts` — `PageRenderer`（单例隐藏 BrowserWindow + renderUrl + 串行队列）
- Modify `main.ts` — `render:request` 拦截分支（onNotification）+ PageRenderer 实例化 + render:result 回调
- Modify `scripts/electron-security.test.mjs` 或新增 `scripts/page-renderer.test.mjs` — 源码检查测试

---

## Task 1: RenderClient 接口与 noop 默认实现（SDK）

**Files:**
- Create: `packages/sdk/src/tools/render-client.ts`
- Test: `packages/sdk/src/tools/render-client.test.ts`

**Interfaces:**
- Produces: `RenderClient`（`renderUrl(url, options?) => Promise<RenderOutcome>`）、`RenderOutcome`（`{ok:true,html,finalUrl,status?} | {ok:false,error:{code,message}}`）、`RenderOptions`（`{timeoutMs?,waitForSelector?}`）、`createNoopRenderClient()`。后续任务（T5/T6）依赖这些类型。

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/src/tools/render-client.test.ts
import { describe, expect, test } from "bun:test";
import { createNoopRenderClient } from "./render-client.js";

describe("createNoopRenderClient", () => {
  test("returns render_unavailable outcome without throwing", async () => {
    const client = createNoopRenderClient();
    const out = await client.renderUrl("https://example.com");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("render_unavailable");
      expect(out.error.message).toMatch(/render/i);
    }
  });

  test("exposes renderUrl as a function", () => {
    const client = createNoopRenderClient();
    expect(typeof client.renderUrl).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/tools/render-client.test.ts`
Expected: FAIL — "Cannot find module './render-client.js'"

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/sdk/src/tools/render-client.ts
/**
 * RenderClient — abstracts "render a URL and return its post-JS HTML".
 * SDK defines only the interface + a no-op default (headless fallback).
 * The real reverse-RPC implementation lives in apps/sidecar.
 */

export interface RenderOptions {
  timeoutMs?: number;
  waitForSelector?: string;
}

export interface RenderSuccess {
  ok: true;
  html: string;
  finalUrl: string;
  status?: number;
}

export interface RenderFailure {
  ok: false;
  error: { code: string; message: string };
}

export type RenderOutcome = RenderSuccess | RenderFailure;

export interface RenderClient {
  renderUrl(url: string, options?: RenderOptions): Promise<RenderOutcome>;
}

/** Default client used when no renderer is available (headless sidecar / CLI). */
export function createNoopRenderClient(): RenderClient {
  return {
    async renderUrl() {
      return {
        ok: false,
        error: {
          code: "render_unavailable",
          message: "Rendering is unavailable in this environment (desktop only).",
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/tools/render-client.test.ts`
Expected: PASS (2 tests)

---

## Task 2: 图片管线（resolveImgSrc + downloadAndLocalizeImages + lumeFileUrl + fetchIdFromUrl）

**Files:**
- Create: `packages/sdk/src/tools/image-pipeline.ts`
- Test: `packages/sdk/src/tools/image-pipeline.test.ts`

**Interfaces:**
- Consumes: `sdkFetch`（`./web-request.js`，签名 `(input: string, init?: RequestInit) => Promise<Response>`，仅用于类型；运行时通过参数注入便于 mock）。
- Produces: `resolveImgSrc(el): string | null`、`downloadAndLocalizeImages(html, pageUrl, imagesDir, mode, fetchImpl): Promise<{html, downloaded, failed}>`、`lumeFileUrl(absPath): string`、`fetchIdFromUrl(url): string`。T5/T6 依赖这些。

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/src/tools/image-pipeline.test.ts
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { resolveImgSrc, downloadAndLocalizeImages, lumeFileUrl, fetchIdFromUrl } from "./image-pipeline.js";

describe("lumeFileUrl", () => {
  test("encodes absolute path into lume-file URL", () => {
    expect(lumeFileUrl("/home/u/.lume/agent-workspaces/a/resources/fetches/abc/images/x.png"))
      .toBe("lume-file://file/" + encodeURIComponent("/home/u/.lume/agent-workspaces/a/resources/fetches/abc/images/x.png"));
  });
});

describe("fetchIdFromUrl", () => {
  test("returns 8-hex prefix of sha256(url), stable for same url", () => {
    const id = fetchIdFromUrl("https://mp.weixin.qq.com/s/yIWl8Yv4T2QRUg446UEKeQ");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(fetchIdFromUrl("https://mp.weixin.qq.com/s/yIWl8Yv4T2QRUg446UEKeQ")).toBe(id);
  });
  test("differs for different urls", () => {
    expect(fetchIdFromUrl("https://a.com")).not.toBe(fetchIdFromUrl("https://b.com"));
  });
});

describe("resolveImgSrc", () => {
  const dom = (html: string) => new JSDOM(html).window.document;
  test("uses src when present", () => {
    const img = dom(`<img src="https://a.com/1.png">`).querySelector("img")!;
    expect(resolveImgSrc(img as any)).toBe("https://a.com/1.png");
  });
  test("falls back to data-src for lazy-loaded images", () => {
    const img = dom(`<img data-src="https://a.com/2.png">`).querySelector("img")!;
    expect(resolveImgSrc(img as any)).toBe("https://a.com/2.png");
  });
  test("falls back to data-original then data-lazy-src", () => {
    const img1 = dom(`<img data-original="https://a.com/3.png">`).querySelector("img")!;
    const img2 = dom(`<img data-lazy-src="https://a.com/4.png">`).querySelector("img")!;
    expect(resolveImgSrc(img1 as any)).toBe("https://a.com/3.png");
    expect(resolveImgSrc(img2 as any)).toBe("https://a.com/4.png");
  });
  test("returns null when no usable source", () => {
    const img = dom(`<img alt="no src">`).querySelector("img")!;
    expect(resolveImgSrc(img as any)).toBeNull();
  });
});

describe("downloadAndLocalizeImages", () => {
  test("download mode: fetches with Referer=page origin, writes hash-named file, rewrites src to lume-file", async () => {
    const tmp = await import("node:fs/promises");
    const dir = await tmp.mkdtemp((await import("node:os")).tmpdir() + "/lume-img-");
    const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (url: string, init?: any) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return new Response(png1x1, { status: 200, headers: { "content-type": "image/png" } });
    }) as any;

    const html = `<img data-src="//mmbiz.qpic.cn/a.png">`;
    const out = await downloadAndLocalizeImages(html, "https://mp.weixin.qq.com/s/abc", dir, "download", fakeFetch);

    expect(calls[0].url).toBe("https://mmbiz.qpic.cn/a.png");
    expect(calls[0].headers["Referer"]).toBe("https://mp.weixin.qq.com/");
    expect(out.downloaded).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.html).toContain("lume-file://file/");
    // file written with .png extension
    const files = await tmp.readdir(dir);
    expect(files.some((f) => f.endsWith(".png"))).toBe(true);
    await tmp.rm(dir, { recursive: true, force: true });
  });

  test("keep mode: only rewrites src to absolute URL, does not fetch", async () => {
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => { fetched.push(url); return new Response(Buffer.from("x")); }) as any;
    const out = await downloadAndLocalizeImages(`<img data-src="/img/a.png">`, "https://example.com/page", "/tmp/none", "keep", fakeFetch);
    expect(fetched.length).toBe(0);
    expect(out.html).toContain('src="https://example.com/img/a.png"');
  });

  test("download failure degrades to original URL, counts failed", async () => {
    const fakeFetch = (async () => new Response("", { status: 403 })) as any;
    const out = await downloadAndLocalizeImages(`<img src="https://a.com/x.png">`, "https://example.com", "/tmp/none", "download", fakeFetch);
    expect(out.failed).toBe(1);
    expect(out.downloaded).toBe(0);
    expect(out.html).toContain("https://a.com/x.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/tools/image-pipeline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
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
          ...(origin ? { Referer: origin } : {}),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/tools/image-pipeline.test.ts`
Expected: PASS (all). If base64 PNG fails decode, replace with any valid small PNG base64.

- [ ] **Step 5: Typecheck**

Run: `cd packages/sdk && npx tsc --noEmit`
Expected: no errors.

---

## Task 3: 渲染触发判定 shouldRender（SDK）

**Files:**
- Create: `packages/sdk/src/tools/render-judge.ts`
- Test: `packages/sdk/src/tools/render-judge.test.ts`

**Interfaces:**
- Produces: `shouldRender(rawHtml, mode: 'auto'|'force'|'off'): boolean`。T5 依赖。

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/src/tools/render-judge.test.ts
import { describe, expect, test } from "bun:test";
import { shouldRender } from "./render-judge.js";

describe("shouldRender", () => {
  test("off => false", () => {
    expect(shouldRender("<html><body>x</body></html>", "off")).toBe(false);
  });
  test("force => true", () => {
    expect(shouldRender("<html></html>", "force")).toBe(true);
  });
  test("auto + normal article => false", () => {
    const body = "x".repeat(500);
    expect(shouldRender(`<html><body><article>${body}</article></body></html>`, "auto")).toBe(false);
  });
  test("auto + SPA shell (#app, little text) => true", () => {
    expect(shouldRender(`<html><body><div id="app"></div></body></html>`, "auto")).toBe(true);
  });
  test("auto + tiny body (< MIN_BODY_CHARS) => true", () => {
    expect(shouldRender(`<html><body>hi</body></html>`, "auto")).toBe(true);
  });
  test("auto + error shell (404) => false (rendering won't help)", () => {
    expect(shouldRender(`<html><head><title>404 Not Found</title></head><body>x</body></html>`, "auto")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/tools/render-judge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/sdk/src/tools/render-judge.ts
export type RenderMode = "auto" | "force" | "off";

export const MIN_BODY_CHARS = 200;

const SPA_ROOT_IDS = new Set(["app", "root", "__next", "__nuxt"]);

export function shouldRender(rawHtml: string, mode: RenderMode): boolean {
  if (mode === "off") return false;
  if (mode === "force") return true;
  // auto
  if (isErrorShell(rawHtml)) return false;
  if (hasSpaShell(rawHtml)) return true;
  if (bodyTextLength(rawHtml) < MIN_BODY_CHARS) return true;
  return false;
}

export function bodyTextLength(rawHtml: string): number {
  const bodyMatch = rawHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : rawHtml;
  const stripped = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  return stripped.replace(/\s+/g, " ").trim().length;
}

export function hasSpaShell(rawHtml: string): boolean {
  if (!/id="(app|root|__next|__nuxt)"/i.test(rawHtml)) return false;
  return bodyTextLength(rawHtml) < MIN_BODY_CHARS;
}

export function isErrorShell(rawHtml: string): boolean {
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || "").toLowerCase();
  if (/(403|404|not found|forbidden|access denied)/i.test(title)) return true;
  return false;
}

void SPA_ROOT_IDS; // reserved for future per-id tuning
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/tools/render-judge.test.ts`
Expected: PASS (6 tests).

---

## Task 4: 资产 Markdown 构造 buildAssetFile（frontmatter + 正文）

**Files:**
- Create: `packages/sdk/src/tools/asset-markdown.ts`
- Test: `packages/sdk/src/tools/asset-markdown.test.ts`

**Interfaces:**
- Produces: `buildAssetFile({source, fetchedAt, title?, markdown}): string`（YAML frontmatter + 正文）。T5 依赖。

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/src/tools/asset-markdown.test.ts
import { describe, expect, test } from "bun:test";
import { buildAssetFile } from "./asset-markdown.js";

describe("buildAssetFile", () => {
  test("writes frontmatter with required source + fetched_at, then markdown body", () => {
    const out = buildAssetFile({
      source: "https://mp.weixin.qq.com/s/abc",
      fetchedAt: "2026-07-09T12:34:56Z",
      title: "Hello",
      markdown: "# Hello\n\nbody",
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain('source: "https://mp.weixin.qq.com/s/abc"');
    expect(out).toContain("fetched_at: 2026-07-09T12:34:56Z");
    expect(out).toContain('title: "Hello"');
    expect(out).toContain("# Hello\n\nbody");
    // frontmatter closed before body
    expect(out.indexOf("---", 4)).toBeLessThan(out.indexOf("# Hello"));
  });

  test("omits title line when title is undefined", () => {
    const out = buildAssetFile({ source: "https://a.com", fetchedAt: "2026-07-09T00:00:00Z", markdown: "body" });
    expect(out).not.toContain("title:");
  });

  test("escapes quotes in source", () => {
    const out = buildAssetFile({ source: 'https://a.com/?"x=1', fetchedAt: "2026-07-09T00:00:00Z", markdown: "b" });
    expect(out).toContain('source: "https://a.com/?\\"x=1"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/tools/asset-markdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/sdk/src/tools/asset-markdown.ts
export interface AssetFileInput {
  source: string;
  fetchedAt: string; // ISO 8601 UTC
  title?: string;
  markdown: string;
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build index.md content: YAML frontmatter (source/fetched_at[/title]) + markdown body. */
export function buildAssetFile(input: AssetFileInput): string {
  const lines = ["---", `source: ${yamlString(input.source)}`, `fetched_at: ${input.fetchedAt}`];
  if (input.title !== undefined && input.title !== "") {
    lines.push(`title: ${yamlString(input.title)}`);
  }
  lines.push("---", "");
  return lines.join("\n") + input.markdown + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/sdk/src/tools/asset-markdown.test.ts`
Expected: PASS (3 tests).

---

## Task 5: 重构 web-fetch.ts — 抽 runWebFetch 核心（SDK）

**Files:**
- Modify: `packages/sdk/src/tools/web-fetch.ts`
- Create: `packages/sdk/src/tools/web-fetch-enhanced.test.ts`
- Reference: existing `packages/sdk/src/tools/web-fetch.test.ts`（保持通过）

**Interfaces:**
- Consumes: `RenderClient`（T1）、`downloadAndLocalizeImages/lumeFileUrl/fetchIdFromUrl/ImageMode`（T2）、`shouldRender/RenderMode`（T3）、`buildAssetFile`（T4）、`sdkFetch`（`./web-request.js`）、`ensureNetworkAllowed`（`../utils/pathing.js`）、`extractArticleMarkdown`（`./html-to-markdown.js`）。
- Produces: `runWebFetch(input, context, deps?)` 与 `WebFetchDeps`（`{renderClient?, resolveAssetDir?, fetchImpl?}`）。`WebFetchTool` 默认 deps 为空（纯静态，向后兼容）。T9（sidecar 装配）依赖 `runWebFetch`。

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/src/tools/web-fetch-enhanced.test.ts
import { describe, expect, test } from "bun:test";
import { runWebFetch } from "./web-fetch.js";
import type { RenderClient } from "./render-client.js";
import { createNoopRenderClient } from "./render-client.js";

const ctx = { sandbox: undefined } as any;

function fakeArticleHtml(body: string) {
  return `<html><head><title>T</title></head><body><article>${body}</article></body></html>`;
}

describe("runWebFetch — static path (default deps)", () => {
  test("returns markdown from static html, no assets written", async () => {
    const fetchImpl = (async () => new Response(fakeArticleHtml("x".repeat(300)), { headers: { "content-type": "text/html" } })) as any;
    const out = await runWebFetch({ url: "https://example.com/a", format: "markdown" }, ctx, { fetchImpl });
    expect(out.is_error).toBeFalsy();
    expect(out.data).toContain("T");
  });
});

describe("runWebFetch — render fallback", () => {
  test("auto mode renders SPA shell via renderClient", async () => {
    const fetchImpl = (async () => new Response(`<html><body><div id="app"></div></body></html>`, { headers: { "content-type": "text/html" } })) as any;
    const renderClient: RenderClient = {
      async renderUrl() {
        return { ok: true, html: fakeArticleHtml("rendered".repeat(60)), finalUrl: "https://example.com/a" };
      },
    };
    const out = await runWebFetch({ url: "https://example.com/a" }, ctx, { fetchImpl, renderClient });
    expect(out.data.toLowerCase()).toContain("rendered");
  });

  test("render failure degrades to static with notice", async () => {
    const fetchImpl = (async () => new Response(`<html><body><div id="app"></div></body></html>`, { headers: { "content-type": "text/html" } })) as any;
    const out = await runWebFetch({ url: "https://example.com/a" }, ctx, { fetchImpl, renderClient: createNoopRenderClient() });
    expect(out.data).toMatch(/static|render/i);
  });
});

describe("runWebFetch — assets", () => {
  test("writes index.md with frontmatter when resolveAssetDir provided", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lume-wf-"));
    const fetchImpl = (async () => new Response(fakeArticleHtml("x".repeat(300)), { headers: { "content-type": "text/html" } })) as any;
    const out = await runWebFetch(
      { url: "https://example.com/a" },
      ctx,
      { fetchImpl, resolveAssetDir: () => dir },
    );
    expect(out.data).toContain("Asset:");
    const md = await fs.readFile(path.join(dir, "index.md"), "utf8");
    expect(md).toContain("source:");
    expect(md).toContain("fetched_at:");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/sdk/src/tools/web-fetch-enhanced.test.ts`
Expected: FAIL — `runWebFetch` not exported.

- [ ] **Step 3: Rewrite web-fetch.ts**

```ts
// packages/sdk/src/tools/web-fetch.ts
/**
 * WebFetchTool - Fetch web content, optional JS-render fallback + image/asset localization.
 */
import { defineTool } from "./types.js";
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

type ToolContext = Parameters<Extract<Parameters<typeof defineTool>[0], { call: any }>["call"]>[1];

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
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, context) {
    return runWebFetch(input as WebFetchInput, context);
  },
});
```

> Note: `extractArticleMarkdown` is now imported directly (the old dynamic-import obfuscation is removed for clarity — verify `html-to-markdown.ts` exports it, which it does at `html-to-markdown.ts:10`).

- [ ] **Step 4: Run tests**

Run: `bun test packages/sdk/src/tools/web-fetch-enhanced.test.ts packages/sdk/src/tools/web-fetch.test.ts`
Expected: PASS. The existing `web-fetch.test.ts` asserts `isReadOnly?.()` is `true` — **update that assertion** in `web-fetch.test.ts:8` from `.toBe(true)` to `.toBe(false)` (both isReadOnly and isConcurrencySafe are now false), since the tool now has filesystem side effects.

- [ ] **Step 5: Typecheck**

Run: `cd packages/sdk && npx tsc --noEmit`
Expected: no errors. If the `ToolContext` derivation is fragile, replace with `context: any` in `runWebFetch` signature (SDK-internal; the sidecar wrapper passes the real context).

---

## Task 6: reverse-RPC RenderClient（sidecar）

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/tools/web/reverse-rpc-render-client.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/web/reverse-rpc-render-client.test.ts`

**Interfaces:**
- Consumes: `RenderClient`/`RenderOutcome` from `@lume/agent-sdk`（T1 导出，需在 SDK index re-export——见 Step 3 注）；`NotificationWriter`（`(method, params) => void`）。
- Produces: `createReverseRpcRenderClient({sendNotification, timeoutMs?})` 返回 `{ renderUrl, handleRenderResult }`（实现 RenderClient + 额外 `handleRenderResult`）。T7/T9 依赖。

> **Pre-req**: SDK 必须导出 `RenderClient` 等类型。在 `packages/sdk/src/index.ts` 加 `export * from "./tools/render-client.js";`（如未导出）。先做这步再写测试。

- [ ] **Step 1: Ensure SDK exports RenderClient types**

In `packages/sdk/src/index.ts`, add (near other tool exports):
```ts
export * from "./tools/render-client.js";
```
Verify: `cd packages/sdk && npx tsc --noEmit`.

- [ ] **Step 2: Write the failing test**

```ts
// apps/sidecar/src/services/agent-runtime/tools/web/reverse-rpc-render-client.test.ts
import { describe, expect, test } from "bun:test";
import { createReverseRpcRenderClient } from "./reverse-rpc-render-client.js";

function harness() {
  const sent: { method: string; params: any }[] = [];
  const sendNotification = (method: string, params: unknown) => { sent.push({ method, params: params as any }); };
  const client = createReverseRpcRenderClient({ sendNotification, timeoutMs: 50 });
  return { sent, client };
}

describe("createReverseRpcRenderClient", () => {
  test("renderUrl sends render:request with reqId and awaits matching render:result", async () => {
    const { sent, client } = harness();
    const p = client.renderUrl("https://example.com", { waitForSelector: "#main" });
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("render:request");
    const reqId = sent[0].params.reqId;
    expect(sent[0].params.url).toBe("https://example.com");
    expect(sent[0].params.options?.waitForSelector).toBe("#main");

    client.handleRenderResult({ reqId, html: "<html>RENDERED</html>", finalUrl: "https://example.com", status: 200 });
    const out = await p;
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.html).toContain("RENDERED");
  });

  test("renderUrl resolves to failure when result carries error", async () => {
    const { sent, client } = harness();
    const p = client.renderUrl("https://example.com");
    const reqId = sent[0].params.reqId;
    client.handleRenderResult({ reqId, error: { code: "render_timeout", message: "timed out" } });
    const out = await p;
    expect(out.ok).toBe(false);
  });

  test("renderUrl rejects on timeout when no result arrives", async () => {
    const { client } = harness();
    const out = await client.renderUrl("https://example.com");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("render_timeout");
  });

  test("unknown reqId result is ignored", async () => {
    const { client } = harness();
    expect(() => client.handleRenderResult({ reqId: "nope", html: "x" })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test apps/sidecar/src/services/agent-runtime/tools/web/reverse-rpc-render-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// apps/sidecar/src/services/agent-runtime/tools/web/reverse-rpc-render-client.ts
import type { RenderClient, RenderOutcome, RenderOptions } from "@lume/agent-sdk";

const RENDER_REQUEST = "render:request";

interface Pending {
  resolve: (v: RenderOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ReverseRpcRenderClient extends RenderClient {
  handleRenderResult(params: {
    reqId: string;
    html?: string;
    finalUrl?: string;
    status?: number;
    error?: { code: string; message: string };
  }): void;
}

export function createReverseRpcRenderClient(opts: {
  sendNotification: (method: string, params: unknown) => void;
  timeoutMs?: number;
}): ReverseRpcRenderClient {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const pending = new Map<string, Pending>();
  let counter = 0;

  function renderUrl(url: string, options?: RenderOptions): Promise<RenderOutcome> {
    const reqId = `r${Date.now()}-${counter++}`;
    return new Promise<RenderOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(reqId)) {
          resolve({ ok: false, error: { code: "render_timeout", message: `render timed out after ${timeoutMs}ms` } });
        }
      }, options?.timeoutMs ?? timeoutMs);
      pending.set(reqId, { resolve, timer });
      opts.sendNotification(RENDER_REQUEST, { reqId, url, options: options ?? {} });
    });
  }

  function handleRenderResult(params: {
    reqId: string; html?: string; finalUrl?: string; status?: number;
    error?: { code: string; message: string };
  }): void {
    const entry = pending.get(params.reqId);
    if (!entry) return;
    pending.delete(params.reqId);
    clearTimeout(entry.timer);
    if (params.error) {
      entry.resolve({ ok: false, error: params.error });
    } else {
      entry.resolve({ ok: true, html: params.html ?? "", finalUrl: params.finalUrl ?? "", status: params.status });
    }
  }

  return { renderUrl, handleRenderResult };
}
```

> `Date.now()` is fine here (this runs in the sidecar runtime, not a workflow script).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test apps/sidecar/src/services/agent-runtime/tools/web/reverse-rpc-render-client.test.ts`
Expected: PASS (4 tests).

---

## Task 7: 注册 render:result handler（sidecar RPC）

**Files:**
- Modify: `apps/sidecar/src/rpc/create-rpc-handlers.ts`
- Reference: `apps/sidecar/src/rpc/reading-handlers.ts:105-107`（handler 工厂模式）

**Interfaces:**
- Consumes: `ReverseRpcRenderClient`（T6，通过 context 注入）。
- Produces: RPC handler `render:result`（params.reqId → renderClient.handleRenderResult → 返回 `{ok:true}`）。

- [ ] **Step 1: Extend CreateRpcHandlersContext + assign handler**

In `apps/sidecar/src/rpc/create-rpc-handlers.ts`, modify the context interface and the `Object.assign` block:

```ts
// Add to CreateRpcHandlersContext (create-rpc-handlers.ts:16-18):
export interface CreateRpcHandlersContext {
  writeNotification: NotificationWriter;
  renderClient?: { handleRenderResult: (params: any) => void }; // NEW
}

// In create-rpc-handlers.ts body, before the final `return handlers`:
if (context.renderClient) {
  handlers["render:result"] = async (params: unknown) => {
    context.renderClient!.handleRenderResult(params as any);
    return { ok: true };
  };
}
```

- [ ] **Step 2: Wire renderClient into createRpcHandlers at the call site**

In `apps/sidecar/src/index.ts` around line 51, the renderClient must be created before handlers and passed in. This is finalized in Task 9 (assembly); for now, ensure `createRpcHandlers` accepts the optional field and defaults safely. Verify typecheck:

Run: `cd apps/sidecar && npx tsc --noEmit`
Expected: no errors (renderClient optional).

- [ ] **Step 3: Write handler test**

```ts
// apps/sidecar/src/rpc/create-rpc-handlers.render.test.ts
import { describe, expect, test } from "bun:test";
import { createRpcHandlers } from "./create-rpc-handlers.js";

describe("render:result handler", () => {
  test("forwards params to renderClient.handleRenderResult and returns {ok:true}", async () => {
    const seen: any[] = [];
    const handlers = createRpcHandlers({
      writeNotification: () => {},
      renderClient: { handleRenderResult: (p) => seen.push(p) },
    } as any);
    const h = handlers["render:result"];
    expect(h).toBeDefined();
    const out = await h({ reqId: "r1", html: "<x>", finalUrl: "https://a.com" });
    expect(out).toEqual({ ok: true });
    expect(seen[0]).toEqual({ reqId: "r1", html: "<x>", finalUrl: "https://a.com" });
  });

  test("absent renderClient => no render:result handler registered", () => {
    const handlers = createRpcHandlers({ writeNotification: () => {} } as any);
    expect(handlers["render:result"]).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run test**

Run: `bun test apps/sidecar/src/rpc/create-rpc-handlers.render.test.ts`
Expected: PASS (2 tests).

> Note: If `createRpcHandlers` already runs side-effectful setup (subscribing emitters) that breaks under a bare `writeNotification`, guard the test by passing a no-op `writeNotification` and tolerating any internal subscription logs. The handler itself is pure.

---

## Task 8: PageRenderer（desktop main 进程）

**Files:**
- Create: `apps/desktop/src/page-renderer.ts`
- Create: `apps/desktop/scripts/page-renderer.test.mjs`（源码检查测试）
- Reference: `apps/desktop/src/main.ts:626-659`（wereadWindow 范式）、`main.ts:371-390`（attachWebContentsSecurity）、`main.ts:223-230`（createSecureWebPreferences）

**Interfaces:**
- Consumes: Electron `BrowserWindow`、`createSecureWebPreferences()`（main.ts）、`attachWebContentsSecurity()`（main.ts）。
- Produces: `PageRenderer` class（`renderUrl(url, options) => Promise<{html, finalUrl, status}>`，单例隐藏窗口 + 串行队列）。

> `createSecureWebPreferences` 和 `attachWebContentsSecurity` 当前定义在 `main.ts`。若要在 `page-renderer.ts` 复用，需将它们导出或移至 `desktop-core.ts`/`electron-security.ts`。**决策：导出它们**（最小改动）。

- [ ] **Step 1: Export helpers from main.ts**

In `apps/desktop/src/main.ts`, add `export` to the two function declarations:
- `export function createSecureWebPreferences(...)`（currently `main.ts:223`）
- `export function attachWebContentsSecurity(...)`（currently `main.ts:371`）

Run: `cd apps/desktop && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 2: Write source-inspection test (fails first)**

```js
// apps/desktop/scripts/page-renderer.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "page-renderer.ts"), "utf8");

test("page-renderer.ts exists and exports PageRenderer", () => {
  assert.match(src, /export class PageRenderer/);
});

test("render window is created hidden with secure prefs", () => {
  assert.match(src, /show:\s*false/);
  assert.match(src, /createSecureWebPreferences\(\)/);
});

test("renderUrl uses loadURL + executeJavaScript to serialize DOM", () => {
  assert.match(src, /\.loadURL\(/);
  assert.match(src, /executeJavaScript/);
  assert.match(src, /document\.documentElement\.outerHTML/);
});

test("renders are serialized via a queue", () => {
  assert.match(src, /queue|enqueue|pending|serialized/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test apps/desktop/scripts/page-renderer.test.mjs`
Expected: FAIL — file not found.

- [ ] **Step 4: Write PageRenderer**

```ts
// apps/desktop/src/page-renderer.ts
import { BrowserWindow } from "electron";
import { createSecureWebPreferences, attachWebContentsSecurity } from "./main.js";

export interface RenderUrlOptions {
  timeoutMs?: number;
  waitForSelector?: string;
}

export interface RenderUrlResult {
  html: string;
  finalUrl: string;
  status?: number;
}

const DEFAULT_TIMEOUT_MS = 45000;

/**
 * Renders a URL in a hidden BrowserWindow and returns post-JS serialized HTML.
 * Single shared window, serial queue (one render at a time).
 */
export class PageRenderer {
  private win: BrowserWindow | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      show: false,
      webPreferences: createSecureWebPreferences(),
    });
    attachWebContentsSecurity(win, {
      allowNavigation: () => true, // navigation policy enforced by caller URL sandbox; renderer window is headless
    });
    win.on("closed", () => { this.win = null; });
    this.win = win;
    return win;
  }

  /** Serialize render requests one at a time. */
  renderUrl(url: string, options: RenderUrlOptions = {}): Promise<RenderUrlResult> {
    const run = this.chain.then(() => this.doRender(url, options));
    // keep chain alive even on failure
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doRender(url: string, options: RenderUrlOptions): Promise<RenderUrlResult> {
    const win = await this.ensureWindow();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    await Promise.race([
      win.webContents.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error("render_load_timeout")), timeoutMs)),
    ]);

    // wait for ready + optional selector
    await this.waitForReady(win, options, timeoutMs);

    const script = options.waitForSelector
      ? `(() => ({ html: document.documentElement.outerHTML, url: location.href }))()`
      : `(() => ({ html: document.documentElement.outerHTML, url: location.href }))()`;
    const result = await Promise.race([
      win.webContents.executeJavaScript(`(${script})`) as Promise<{ html: string; url: string }>,
      new Promise((_, reject) => setTimeout(() => reject(new Error("render_exec_timeout")), timeoutMs)),
    ]);

    return { html: result.html, finalUrl: result.url };
  }

  private async waitForReady(win: BrowserWindow, options: RenderUrlOptions, timeoutMs: number): Promise<void> {
    const selector = options.waitForSelector;
    const deadline = Date.now() + timeoutMs;
    // poll readyState + selector up to deadline (cap wait at min(timeout, 5s) after load)
    const cap = Math.min(timeoutMs, 5000);
    const start = Date.now();
    while (Date.now() - start < cap && Date.now() < deadline) {
      try {
        const ok = await win.webContents.executeJavaScript(
          `(() => document.readyState === 'complete' && (${selector ? `!!document.querySelector(${JSON.stringify(selector)})` : 'true'}))()`,
        ) as boolean;
        if (ok) return;
      } catch { /* ignore poll errors */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async dispose(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test apps/desktop/scripts/page-renderer.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck**

Run: `cd apps/desktop && npx tsc -p tsconfig.json --noEmit`
Expected: no errors. (Circular import main↔page-renderer is fine for type-only `export function` re-use; both are main-process modules.)

---

## Task 9: sidecar 装配 — createSdkWebTools 工厂 + renderClient 注入

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/web/create-web-tools.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`（装配点，约 `run.ts:593`）
- Modify: `apps/sidecar/src/index.ts`（创建 renderClient 单例并传入 handlers + runtime）

**Interfaces:**
- Consumes: `runWebFetch`/`WebFetchTool`/`RenderClient`（SDK）、`createReverseRpcRenderClient`（T6）、`getWorkspaceResourcesPath`（`services/infra/config-paths.js`）、`fetchIdFromUrl`（SDK，需 re-export）。
- Produces: `createSdkWebTools({workspaceSlug, renderClient})` 返回增强工具集（WebFetch 注入 renderClient + assetDir 解析）。

> **Pre-req**: SDK re-export。在 `packages/sdk/src/index.ts` 加：
> - `export * from "./tools/image-pipeline.js";`（导出 `fetchIdFromUrl`/`lumeFileUrl`/`downloadAndLocalizeImages`）
> - 确认 `runWebFetch` 已随 web-fetch 导出（若 index.ts 仅命名导出 `WebFetchTool`，追加 `export { runWebFetch } from "./tools/web-fetch.js";`）
> Verify `cd packages/sdk && npx tsc --noEmit`.

- [ ] **Step 1: Rewrite create-web-tools.ts as a factory**

```ts
// apps/sidecar/src/services/agent-runtime/tools/web/create-web-tools.ts
import type { ToolDefinition } from "@lume/agent-sdk";
import { runWebFetch, WebFetchTool, fetchIdFromUrl, type RenderClient } from "@lume/agent-sdk";
import { WebSearchTool, GuanlanSearchTool, GuanlanReadTool, GuanlanHotnewsTool, GuanlanResearchTool } from "@lume/agent-sdk";
import { defineTool } from "@lume/agent-sdk";
import { getWorkspaceResourcesPath } from "../../../../services/infra/config-paths.js";
import { join } from "node:path";

export interface CreateSdkWebToolsInput {
  workspaceSlug?: string;
  renderClient?: RenderClient;
}

export function createSdkWebTools(input: CreateSdkWebToolsInput = {}): ToolDefinition[] {
  const webFetch = createEnhancedWebFetch(input);
  return [WebSearchTool, webFetch, GuanlanSearchTool, GuanlanReadTool, GuanlanHotnewsTool, GuanlanResearchTool];
}

function createEnhancedWebFetch(input: CreateSdkWebToolsInput): ToolDefinition {
  const { workspaceSlug, renderClient } = input;
  return defineTool({
    name: "WebFetch",
    description: WebFetchTool.description ?? "Fetch a URL as Markdown.",
    inputSchema: WebFetchTool.inputSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async call(toolInput, context) {
      return runWebFetch(toolInput as any, context, {
        renderClient,
        resolveAssetDir: workspaceSlug
          ? (url) => join(getWorkspaceResourcesPath(workspaceSlug), "fetches", fetchIdFromUrl(url))
          : undefined,
      });
    },
  });
}
```

> Adjust the `@lume/agent-sdk` import list to match actual exports (WebSearchTool/Guanlan* names from existing `create-web-tools.ts:20-29`). Preserve the existing imports verbatim; only swap `WebFetchTool` for the wrapped version.

- [ ] **Step 2: Pass renderClient + workspaceSlug through run.ts assembly**

In `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` (~line 593, `createBaseSdkTools`), change:
```ts
// before:
...createSdkWebTools()
// after:
...createSdkWebTools({ workspaceSlug: options.workspaceSlug, renderClient: options.renderClient })
```
Add `renderClient?: RenderClient` to that function's `options` param type, and thread it from the runtime entry that calls `createBaseSdkTools` (the runtime receives it from index.ts — see Step 3).

- [ ] **Step 3: Create renderClient singleton in index.ts and wire to handlers + runtime**

In `apps/sidecar/src/index.ts`, before `createRpcHandlers` (line 51):
```ts
import { createReverseRpcRenderClient } from "./services/agent-runtime/tools/web/reverse-rpc-render-client.js";
// ...
const renderClient = createReverseRpcRenderClient({ sendNotification: writeNotification });
const handlers = createRpcHandlers({ writeNotification, renderClient });
```
Then expose `renderClient` to the agent runtime (the runtime is constructed where `AgentSendInput` is handled — pass `renderClient` into the runtime factory alongside existing inputs). Locate the runtime construction (search for where `workspaceSlug`/`AgentSendInput` flows) and add `renderClient`.

- [ ] **Step 4: Typecheck + smoke**

Run: `cd apps/sidecar && npx tsc --noEmit`
Expected: no errors.

Run: `bun test apps/sidecar`
Expected: all existing tests still pass.

---

## Task 10: desktop main — render:request 拦截 + PageRenderer 实例化

**Files:**
- Modify: `apps/desktop/src/main.ts`
- Reference: `main.ts:153-157`（onNotification）、`main.ts:892-921`（sidecarHost.call）

**Interfaces:**
- Consumes: `PageRenderer`（T8）、`sidecarHost.call`（main.ts:892）。
- Produces: 拦截 `render:request` → renderUrl → `sidecarHost.call("render:result", {reqId, html|error})`。

- [ ] **Step 1: Add globals + instantiate PageRenderer**

Near `main.ts:92-93` (`let mainWindow`, `let wereadWindow`), add:
```ts
let pageRenderer: PageRenderer | null = null;
```
At app ready (`main.ts` ~1038, inside `app.whenReady()`), after sidecarHost is created:
```ts
import { PageRenderer } from "./page-renderer.js";
pageRenderer = new PageRenderer();
```

- [ ] **Step 2: Intercept render:request in onNotification**

Modify the `onNotification` callback (`main.ts:153-157`). Because `sidecarHost` and `pageRenderer` are assigned after the `createSidecarHost` literal, use outer `let` references captured by closure:

```ts
const sidecarHost = createSidecarHost({
  onNotification(method, params) {
    if (method === "render:request" && params && typeof params.reqId === "string") {
      void handleRenderRequest(params);   // do NOT forward to renderer
      return;
    }
    emitRendererEvent(SIDE_CAR_EVENT_CHANNEL, { method, params });
  },
});
```

Add the handler function (module scope in main.ts):
```ts
async function handleRenderRequest(params: { reqId: string; url: string; options?: { timeoutMs?: number; waitForSelector?: string } }) {
  const { reqId, url, options } = params;
  try {
    if (!pageRenderer) throw new Error("renderer not ready");
    const result = await pageRenderer.renderUrl(url, options ?? {});
    await sidecarHost!.call("render:result", { reqId, html: result.html, finalUrl: result.finalUrl, status: result.status });
  } catch (err: any) {
    const code = String(err?.message || "").includes("timeout") ? "render_timeout" : "render_failed";
    await sidecarHost!.call("render:result", { reqId, error: { code, message: err?.message ?? "render error" } }).catch(() => {});
  }
}
```

> `sidecarHost` is `const` assigned at `main.ts:153`; `handleRenderRequest` references it via non-null assertion — safe because render requests only arrive after sidecar started (post-assignment). If TS complains about use-before-assignment, declare `let sidecarHost: ReturnType<typeof createSidecarHost> | null = null` and assign in whenReady, then use `sidecarHost!`.

- [ ] **Step 3: Source-inspection test**

Append to `apps/desktop/scripts/page-renderer.test.mjs` (or a new `render-rpc.test.mjs`):
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("main.ts intercepts render:request before forwarding", () => {
  assert.match(main, /render:request/);
  assert.match(main, /handleRenderRequest/);
});
test("main.ts calls render:result back via sidecarHost", () => {
  assert.match(main, /render:result/);
});
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test apps/desktop/scripts`
Run: `cd apps/desktop && npx tsc -p tsconfig.json --noEmit`
Expected: tests PASS, typecheck clean.

---

## Task 11: 集成验证 + 手动冒烟清单

**Files:**
- Modify: `apps/desktop/package.json`（test script 加入新测试文件，若用单独文件）
- Doc: 本计划末尾的手动验证清单

> 无自动化 E2E（desktop 无框架）。以下为手动验证步骤，交付前逐项确认。

- [ ] **Step 1: Run full test suites**

Run:
```
bun test packages/sdk
bun test apps/sidecar
bun test apps/desktop/scripts
```
Expected: all PASS.

- [ ] **Step 2: Typecheck all three packages**

Run:
```
cd packages/sdk && npx tsc --noEmit
cd apps/sidecar && npx tsc --noEmit
cd apps/desktop && npx tsc -p tsconfig.json --noEmit
```
Expected: all clean.

- [ ] **Step 3: Manual smoke — static article**

Start the desktop app (dev mode). In an agent session, invoke WebFetch on a known static article URL (e.g. a blog post). Confirm:
- Returns Markdown with title + body.
- Asset written to `~/.lume/agent-workspaces/<slug>/resources/fetches/<id>/index.md` with frontmatter `source` + `fetched_at`.
- Images downloaded into `images/`, Markdown references `lume-file://`, and render in the UI.

- [ ] **Step 4: Manual smoke — WeChat article (anti-hotlink)**

Invoke WebFetch on `https://mp.weixin.qq.com/s/yIWl8Yv4T2QRUg446UEKeQ`. Confirm:
- Body extracted (it's server-rendered, static path).
- `mmbiz.qpic.cn` images downloaded successfully (Referer = `https://mp.weixin.qq.com/`), shown in UI.

- [ ] **Step 5: Manual smoke — SPA fallback**

Invoke WebFetch with `render: "force"` on a known SPA URL (e.g. a React app route). Confirm:
- render:request flows to main, hidden window renders, content returned.
- If a known-SPA site isn't handy, test `render:"auto"` on a client-rendered page and confirm it triggers render (check main process logs).

- [ ] **Step 6: Manual smoke — headless degradation**

Run sidecar in headless/CLI mode (no Electron parentPort). Invoke WebFetch. Confirm:
- Result includes a `[render ... static]` or static-only path; no crash; images still downloaded to assets.

---

## Self-Review (已执行)

**Spec coverage**（对照设计文档章节）：
- §2 目标分层抓取 → T5（runWebFetch 编排）+ T3（shouldRender）+ T8（PageRenderer）
- §2 图片本地化 → T2（image-pipeline）+ T5（接入）
- §2 资产持久化 + frontmatter → T4（buildAssetFile）+ T5（写入）
- §6.3 渲染服务 → T8
- §6.4 reverse-RPC → T6（客户端）+ T7（handler）+ T10（main 拦截）
- §6.5 触发判定 → T3
- §6.6 图片管线 → T2
- §6.2 frontmatter → T4
- §6.7 沙箱 → T5 复用 ensureNetworkAllowed（图片域放宽见下方 gap）
- §6.8 headless 降级 → T1 noop + T6 timeout + T11 验证
- §9 完成条件 → T11 验证清单覆盖

**Placeholder scan**: 无 TBD/TODO；每步含完整代码或确切命令。✅

**Type consistency**:
- `RenderClient.renderUrl(url, options?) => Promise<RenderOutcome>` —— T1 定义，T6 实现，T9 注入，T10 不直接用（main 侧）。一致。
- `RenderOutcome = {ok:true,html,finalUrl,status?} | {ok:false,error:{code,message}}` —— T1/T5/T6 一致。
- `shouldRender(rawHtml, mode)` —— T3 定义、T5 调用。一致。
- `downloadAndLocalizeImages(html, pageUrl, imagesDir, mode, fetchImpl)` —— T2 定义、T5 调用。一致。
- `buildAssetFile({source,fetchedAt,title?,markdown})` —— T4 定义、T5 调用。一致。
- `createReverseRpcRenderClient({sendNotification,timeoutMs?})` —— T6 定义、T9 调用。一致。
- `PageRenderer.renderUrl(url, {timeoutMs?,waitForSelector?})` —— T8 定义、T10 调用。一致。

**Known gaps（实现时注意，非阻塞）**:
1. **图片资源域放宽**（设计 §6.7）：当前 `downloadAndLocalizeImages` 不做域名沙箱二次校验（依赖 `ensureNetworkAllowed` 仅校验主 URL）。若 sandbox 严格限制图片域，需在 T2 增加同 origin / mmbiz 白名单放行逻辑。建议实现 T2 时如需再加一个 `allowedImageHosts` 参数。
2. **`create-web-tools.ts` 现有 import 名**：T9 Step 1 的 `@lume/agent-sdk` 导入列表需对照 `create-web-tools.ts:20-29` 实际名称校正（Guanlan* / WebSearchTool）。
3. **run.ts 装配点确切行**：T9 Step 2 的 `createBaseSdkTools` 在 `run.ts:593`，renderClient 需从 runtime 入口透传——实现时确认 runtime 工厂签名。
4. **main.ts 循环依赖**：T8 从 main.ts 导出 `createSecureWebPreferences`/`attachWebContentsSecurity`，page-renderer.ts 反向 import main.ts。TS 允许（类型/函数），但若打包报循环依赖警告，可把这两个函数移到 `desktop-core.ts`。
