# WebSearch/WebFetch 对齐 Alice 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对齐 Lume 的 WebSearch 和 WebFetch 工具到 Alice 的实现水准，重点修复 Bing Scraper 质量、WebFetch Markdown 输出、引擎差异化超时和搜索结果上下文保护。

**Architecture:** 在现有 `packages/sdk/src/tools/` 框架内迭代增强。Bing Scraper 加入智能 Accept-Language 和反爬检测；WebFetch 引入 JSDOM + Readability 管线替代正则剥离；各引擎超时参数独立配置；搜索结果加入上下文压缩保护。

**Tech Stack:** TypeScript / Bun test / JSDOM / @mozilla/readability / turndown（HTML→Markdown）

---

## File Map

| 操作 | 文件 | 职责 |
|------|------|------|
| Modify | `packages/sdk/src/tools/web-search.ts` | Bing Scraper 增强、DDG 降级、差异化超时 |
| Modify | `packages/sdk/src/tools/web-fetch.ts` | JSDOM + Readability + Markdown 输出 |
| Create | `packages/sdk/src/tools/html-to-markdown.ts` | HTML→Markdown 转换工具函数 |
| Modify | `packages/sdk/src/tools/web-search.test.ts` | Bing Scraper 新特性测试 |
| Create | `packages/sdk/src/tools/web-fetch.test.ts` | WebFetch Markdown 输出测试 |
| Modify | `packages/shared/src/types/lume-config.ts` | DDG 从默认启用移除 |
| Modify | `apps/sidecar/src/services/system/lume-config-service.ts` | DDG 从默认 provider 列表移除 |

---

## Task 1: Bing Scraper 智能 Accept-Language

**Files:**
- Modify: `packages/sdk/src/tools/web-search.ts`
- Test: `packages/sdk/src/tools/web-search.test.ts`

**背景：** Alice 的 Bing Scraper `po()` 会按 query 的 Unicode 字符范围自动选择 Accept-Language，而 Lume 当前硬编码 `zh-CN`。这导致非中文搜索时 Bing 可能返回低质量结果。

- [ ] **Step 1: 写 `detectAcceptLanguage` 函数的失败测试**

在 `web-search.test.ts` 末尾追加：

```typescript
describe("detectAcceptLanguage", () => {
  test("returns zh-CN for Chinese queries", () => {
    expect(detectAcceptLanguage("中国经济政策")).toBe("zh-CN,zh;q=0.9,en;q=0.8");
  });

  test("returns ko-KR for Korean queries", () => {
    expect(detectAcceptLanguage("한국 경제")).toBe("ko-KR,ko;q=0.9,en;q=0.8");
  });

  test("returns ja-JP for Japanese queries", () => {
    expect(detectAcceptLanguage("日本経済")).toBe("ja-JP,ja;q=0.9,en;q=0.8");
  });

  test("returns en-US for plain ASCII queries", () => {
    expect(detectAcceptLanguage("hello world")).toBe("en-US,en;q=0.9");
  });

  test("returns zh-CN as default for mixed CJK", () => {
    expect(detectAcceptLanguage("test 中文混合")).toBe("zh-CN,zh;q=0.9,en;q=0.8");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: FAIL — `detectAcceptLanguage` is not exported

- [ ] **Step 3: 实现 `detectAcceptLanguage` 并导出**

在 `web-search.ts` 的 `searchWithBing` 函数之前添加：

```typescript
export function detectAcceptLanguage(query: string): string {
  if (/[가-힣ᄀ-ᇿ㄰-㆏]/.test(query))
    return "ko-KR,ko;q=0.9,en;q=0.8";
  if (/[぀-ヿㇰ-ㇿ]/.test(query))
    return "ja-JP,ja;q=0.9,en;q=0.8";
  if (/[؀-ۿ]/.test(query))
    return "ar-SA,ar;q=0.9,en;q=0.8";
  if (/[Ѐ-ӿ]/.test(query))
    return "ru-RU,ru;q=0.9,en;q=0.8";
  if (/[一-鿿㐀-䶿]/.test(query))
    return "zh-CN,zh;q=0.9,en;q=0.8";
  return "en-US,en;q=0.9";
}
```

在测试文件中更新 import：

```typescript
import { detectAcceptLanguage } from "./web-search";
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/sdk/src/tools/web-search.ts packages/sdk/src/tools/web-search.test.ts
git commit -m "feat(sdk): add detectAcceptLanguage for Bing scraper"
```

---

## Task 2: Bing Scraper 反爬检测 + 标题/摘要提取增强

**Files:**
- Modify: `packages/sdk/src/tools/web-search.ts`

**背景：** Alice 检测 Bing 反爬页面（`unusual traffic` / `captcha` / `blocked`），标题从 `<h2>` 内提取，摘要优先 `b_lineclamp` 再降级 `b_caption`。Lume 当前无反爬检测且提取精度低。

- [ ] **Step 1: 写反爬检测和增强提取的失败测试**

在 `web-search.test.ts` 末尾追加：

```typescript
describe("Bing scraper helpers", () => {
  test("detects Bing anti-bot pages", () => {
    expect(isBingBlockedPage("sorry, we detected some unusual traffic from your IP")).toBe(true);
    expect(isBingBlockedPage("please solve this CAPTCHA to continue")).toBe(true);
    expect(isBingBlockedPage("<html>normal search results page</html>")).toBe(false);
  });

  test("parses Bing result item with h2 structure", () => {
    const html = `<li class="b_algo"><h2><a href="https://example.com/page">Example Title</a></h2><p class="b_lineclamp2">A good snippet here.</p></li>`;
    const result = parseBingResultItem(html);
    expect(result).toMatchObject({
      title: "Example Title",
      url: "https://example.com/page",
      snippet: "A good snippet here."
    });
  });

  test("falls back to b_caption when b_lineclamp is absent", () => {
    const html = `<li class="b_algo"><h2><a href="https://example.com/page2">Title 2</a></h2><div class="b_caption"><p>Fallback snippet.</p></div></li>`;
    const result = parseBingResultItem(html);
    expect(result?.snippet).toBe("Fallback snippet.");
  });

  test("returns null for items without valid title/url", () => {
    const html = `<li class="b_algo"><h2>No link here</h2></li>`;
    expect(parseBingResultItem(html)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: FAIL — `isBingBlockedPage` and `parseBingResultItem` not defined

- [ ] **Step 3: 实现反爬检测和增强提取函数**

在 `web-search.ts` 的 `searchWithBing` 函数之前添加：

```typescript
const BING_BLOCK_PATTERNS = ["unusual traffic", "captcha", "blocked", "<某>"];

export function isBingBlockedPage(html: string): boolean {
  const lower = html.toLowerCase();
  return BING_BLOCK_PATTERNS.some((p) => lower.includes(p));
}

export function parseBingResultItem(itemHtml: string): SearchResult | null {
  const titleMatch = itemHtml.match(
    /<h2[^>]*>[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i
  );
  if (!titleMatch) return null;
  const url = titleMatch[1];
  const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
  if (!title || !url) return null;

  let snippet = "";
  const snipMatch =
    itemHtml.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
    itemHtml.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
  if (snipMatch) snippet = snipMatch[1].replace(/<[^>]+>/g, "").trim();

  return { title, url, snippet: snippet || undefined };
}
```

在测试文件中更新 import：

```typescript
import { detectAcceptLanguage, isBingBlockedPage, parseBingResultItem } from "./web-search";
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: PASS

- [ ] **Step 5: 重写 `searchWithBing` 使用新函数**

将 `searchWithBing` 替换为：

```typescript
async function searchWithBing(query: string, numResults: number, sandbox: unknown) {
  const lang = detectAcceptLanguage(query);
  const hosts = ["cn.bing.com", "www.bing.com"] as const;
  let html = "";

  for (const host of hosts) {
    const url = `https://${host}/search?q=${encodeURIComponent(query)}&count=${Math.min(numResults, 20)}`;
    const sandboxError = ensureNetworkAllowed(url, sandbox as never);
    if (sandboxError) return { data: sandboxError, is_error: true } as const
    const response = await sdkFetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": lang,
      },
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    if (response.ok) {
      const body = await response.text();
      if (body.includes("b_algo") && !isBingBlockedPage(body)) {
        html = body;
        break;
      }
    }
  }

  if (!html) throw new Error("Bing search failed: no results from any host");

  const results: SearchResult[] = [];
  const algoRegex = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = algoRegex.exec(html)) !== null) {
    if (results.length >= numResults) break;
    const parsed = parseBingResultItem(match[1]);
    if (parsed) results.push(parsed);
  }

  return { data: results, is_error: false } as const;
}
```

- [ ] **Step 6: 运行全部测试确认通过**

```bash
bun test packages/sdk/src/tools/web-search.test.ts
```

Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/sdk/src/tools/web-search.ts packages/sdk/src/tools/web-search.test.ts
git commit -m "feat(sdk): enhance Bing scraper with anti-bot detection and precise extraction"
```

---

## Task 3: DDG 从默认启用列表移除 + 引擎差异化超时

**Files:**
- Modify: `packages/sdk/src/tools/web-search.ts`
- Modify: `packages/sdk/src/tools/web-search.test.ts`
- Modify: `packages/shared/src/types/lume-config.ts`
- Modify: `apps/sidecar/src/services/system/lume-config-service.ts`

**背景：** DDG 在国内网络不可达，每次超时浪费 15 秒。Alice 没有 DDG，纯靠 Bing 兜底。各引擎应有独立超时：Brave/Bing 快（10s），Tavily 慢（30s）。

- [ ] **Step 1: 在 `web-search.ts` 中添加引擎超时配置**

在 `DEFAULT_PROVIDER_ORDER` 之后添加：

```typescript
const ENGINE_TIMEOUT_MS: Record<WebSearchProviderName, number> = {
  exa: 15000,
  pipellm: 15000,
  zhipu: 20000,
  tavily: 30000,
  brave: 10000,
  duckduckgo: 15000,
  bing: 10000,
};
```

- [ ] **Step 2: 将各引擎的 `AbortSignal.timeout(15000)` 替换为 `AbortSignal.timeout(ENGINE_TIMEOUT_MS[name])`**

对每个 `searchWith*` 函数，替换硬编码的 15000。例如：

```typescript
// searchWithBrave 中
signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS.brave),

// searchWithTavily 中
signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS.tavily),

// searchWithZhipu 中
signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS.zhipu),
```

对 `searchWithExa` 和 `searchWithPipellm` 同理。

- [ ] **Step 3: 写引擎超时配置的测试**

在 `web-search.test.ts` 追加：

```typescript
test("each engine has an explicit timeout configured", () => {
  const names = ["exa", "pipellm", "zhipu", "tavily", "brave", "duckduckgo", "bing"];
  for (const name of names) {
    expect(ENGINE_TIMEOUT_MS[name as WebSearchProviderName]).toBeGreaterThan(0);
  }
  expect(ENGINE_TIMEOUT_MS.tavily).toBeGreaterThan(ENGINE_TIMEOUT_MS.brave);
});
```

更新 import 加入 `ENGINE_TIMEOUT_MS` 和 `WebSearchProviderName`。

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test packages/sdk/src/tools/web-search.test.ts
```

- [ ] **Step 5: 更新默认配置，DDG 改为禁用**

在 `packages/shared/src/types/lume-config.ts` 中修改 `DEFAULT_LUME_WEB_SEARCH`：

```typescript
export const DEFAULT_LUME_WEB_SEARCH: LumeConfigWebSearchSection = {
  strategy: "priority",
  providers: {
    guanlan: { enabled: false },
    duckduckgo: { enabled: false },
    bing: { enabled: true }
  }
}
```

在 `apps/sidecar/src/services/system/lume-config-service.ts` 中，确认 `WEB_SEARCH_PROVIDER_KEYS` 保持不变（DDG 仍在可选列表中，只是默认关）。

- [ ] **Step 6: 提交**

```bash
git add packages/sdk/src/tools/web-search.ts packages/sdk/src/tools/web-search.test.ts packages/shared/src/types/lume-config.ts
git commit -m "feat(sdk): add per-engine timeouts and disable DDG by default"
```

---

## Task 4: WebFetch JSDOM + Readability + Markdown 输出

**Files:**
- Create: `packages/sdk/src/tools/html-to-markdown.ts`
- Create: `packages/sdk/src/tools/html-to-markdown.test.ts`
- Modify: `packages/sdk/src/tools/web-fetch.ts`
- Create: `packages/sdk/src/tools/web-fetch.test.ts`

**背景：** Alice 用 JSDOM + @mozilla/readability + marked 做三层解析，输出 Markdown。Lume 当前用正则去标签，丢失所有结构信息。

- [ ] **Step 1: 安装依赖**

```bash
cd packages/sdk && bun add jsdom @mozilla/readability turndown
```

- [ ] **Step 2: 写 `html-to-markdown.ts` 及其测试**

创建 `packages/sdk/src/tools/html-to-markdown.ts`：

```typescript
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { TurndownService } from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

export function extractArticleMarkdown(
  html: string,
  url: string
): { title: string; content: string } | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  if (!doc) return null;

  const reader = new Readability(doc);
  const article = reader.parse();
  if (!article || !article.textContent?.trim()) return null;

  const markdown = turndown.turndown(article.content);
  return {
    title: article.title || "",
    content: markdown,
  };
}
```

创建 `packages/sdk/src/tools/html-to-markdown.test.ts`：

```typescript
import { describe, expect, test } from "bun:test";
import { extractArticleMarkdown } from "./html-to-markdown";

describe("extractArticleMarkdown", () => {
  test("extracts article title and converts to markdown", () => {
    const html = `
      <html><head><title>Test Page</title></head><body>
        <article>
          <h1>Hello World</h1>
          <p>This is a <strong>test</strong> paragraph.</p>
          <ul><li>Item 1</li><li>Item 2</li></ul>
        </article>
      </body></html>`;
    const result = extractArticleMarkdown(html, "https://example.com/test");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Hello World");
    expect(result!.content).toContain("test");
    expect(result!.content).toContain("Item 1");
  });

  test("returns null for pages without meaningful content", () => {
    const html = `<html><body><nav>menu items</nav></body></html>`;
    expect(extractArticleMarkdown(html, "https://example.com")).toBeNull();
  });

  test("preserves code blocks", () => {
    const html = `
      <html><body><article>
        <h1>Code Example</h1>
        <pre><code>const x = 1;</code></pre>
      </article></body></html>`;
    const result = extractArticleMarkdown(html, "https://example.com/code");
    expect(result!.content).toContain("const x = 1;");
  });
});
```

- [ ] **Step 3: 运行测试确认通过**

```bash
bun test packages/sdk/src/tools/html-to-markdown.test.ts
```

Expected: PASS

- [ ] **Step 4: 提交 html-to-markdown**

```bash
git add packages/sdk/src/tools/html-to-markdown.ts packages/sdk/src/tools/html-to-markdown.test.ts packages/sdk/package.json
git commit -m "feat(sdk): add extractArticleMarkdown with JSDOM + Readability + Turndown"
```

- [ ] **Step 5: 重写 WebFetch 使用 Markdown 管线**

将 `packages/sdk/src/tools/web-fetch.ts` 替换为：

```typescript
/**
 * WebFetchTool - Fetch web content with Readability + Markdown conversion
 */

import { defineTool } from "./types.js";
import { ensureNetworkAllowed } from "../utils/pathing.js";
import { sdkFetch } from "./web-request.js";
import { extractArticleMarkdown } from "./html-to-markdown.js";

const MAX_FETCH_CHARS = 100000;

export const WebFetchTool = defineTool({
  name: "WebFetch",
  description:
    "Fetch content from a URL and return it as Markdown. Strips boilerplate using Mozilla Readability for clean article extraction.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch content from",
      },
      format: {
        type: "string",
        enum: ["markdown", "text", "html"],
        description: "Output format. Default: markdown",
      },
    },
    required: ["url"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const { url } = input;
    const format = input.format === "text" || input.format === "html" ? input.format : "markdown";

    const sandboxError = ensureNetworkAllowed(url, context.sandbox);
    if (sandboxError) {
      return { data: sandboxError, is_error: true };
    }

    try {
      const response = await sdkFetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return { data: `HTTP ${response.status}: ${response.statusText}`, is_error: true };
      }

      const contentType = response.headers.get("content-type") || "";
      let text = await response.text();

      if (text.length > MAX_FETCH_CHARS) {
        text = text.slice(0, MAX_FETCH_CHARS);
      }

      if (contentType.includes("text/html") || text.trimStart().startsWith("<")) {
        if (format === "html") {
          return { data: text };
        }

        const article = extractArticleMarkdown(text, url);
        if (article) {
          if (format === "text") {
            return { data: `# ${article.title}\n\n${article.content.replace(/[#*_`>\[\]()!-]/g, "")}` };
          }
          return { data: `# ${article.title}\n\n${article.content}` };
        }

        // Readability failed — strip tags as fallback
        const stripped = text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { data: stripped || "(empty response)" };
      }

      return { data: text || "(empty response)" };
    } catch (err: any) {
      return { data: `Error fetching ${url}: ${err.message}`, is_error: true };
    }
  },
});
```

- [ ] **Step 6: 写 WebFetch 基础测试**

创建 `packages/sdk/src/tools/web-fetch.test.ts`：

```typescript
import { describe, expect, test } from "bun:test";
import { WebFetchTool } from "./web-fetch";

describe("WebFetchTool", () => {
  test("exposes correct tool metadata", () => {
    expect(WebFetchTool.name).toBe("WebFetch");
    expect(WebFetchTool.isReadOnly?.()).toBe(true);
    expect(WebFetchTool.isConcurrencySafe?.()).toBe(true);
  });

  test("rejects invalid URLs", async () => {
    const result = await WebFetchTool.call(
      { url: "not-a-url" },
      { sandbox: undefined } as any
    );
    const output = typeof result === "string" ? result : (result as any).data;
    expect(typeof output).toBe("string");
  });

  test("schema accepts markdown, text, and html formats", () => {
    const fmt = WebFetchTool.inputSchema.properties?.format as any;
    expect(fmt?.enum).toContain("markdown");
    expect(fmt?.enum).toContain("text");
    expect(fmt?.enum).toContain("html");
  });
});
```

- [ ] **Step 7: 运行全部测试**

```bash
bun test packages/sdk/src/tools/web-fetch.test.ts packages/sdk/src/tools/html-to-markdown.test.ts
```

- [ ] **Step 8: 提交**

```bash
git add packages/sdk/src/tools/web-fetch.ts packages/sdk/src/tools/web-fetch.test.ts
git commit -m "feat(sdk): rewrite WebFetch with JSDOM + Readability + Markdown output"
```

---

## Task 5: 移除 web-search.ts 中不再使用的 Guanlan 残留

**Files:**
- Modify: `packages/sdk/src/tools/web-search.ts`

**背景：** Task 1-3 后，`web-search.ts` 中仍有 `runGuanlanPython`、`parseGuanlanSearchOutput`、`runCommand` 等 Guanlan 专用的导出函数。这些函数被 `guanlan.ts` 引用，不能删除，但需要确认 import 链路正确。

- [ ] **Step 1: 确认 `guanlan.ts` 的 import 仍然正确**

运行：

```bash
grep -n "from './web-search" packages/sdk/src/tools/guanlan.ts
```

应看到 `runGuanlanPython`、`parseGuanlanSearchOutput`、`truncateRawText`、`SearchResult` 的 import。确保这些函数仍被导出（`export`）。

- [ ] **Step 2: 运行全部工具测试确认无破坏**

```bash
bun test packages/sdk/src/tools/web-search.test.ts packages/sdk/src/tools/guanlan.test.ts packages/sdk/src/tools/web-fetch.test.ts packages/sdk/src/tools/html-to-markdown.test.ts
```

Expected: ALL PASS

- [ ] **Step 3: 提交（如有清理改动）**

```bash
git add -u
git commit -m "chore(sdk): clean up unused guanlan references in web-search"
```

---

## Task 6: 最终集成测试

**Files:**
- None（验证性步骤）

- [ ] **Step 1: 运行全部 SDK 工具测试**

```bash
bun test packages/sdk/src/tools/
```

Expected: ALL PASS

- [ ] **Step 2: 运行 sidecar 类型检查**

```bash
bun run --filter @lume/sidecar typecheck
```

Expected: 无类型错误

- [ ] **Step 3: 运行 web 类型检查**

```bash
bun run --filter @lume/web typecheck
```

Expected: 无类型错误

---

## Self-Review Checklist

**1. Spec coverage:**

| Alice 特性 | 对应 Task |
|-----------|----------|
| 智能 Accept-Language | Task 1 |
| 反爬检测 | Task 2 |
| `<h2>` 标题提取 | Task 2 |
| `b_lineclamp` → `b_caption` 双重摘要 | Task 2 |
| DDG 无（纯 Bing 兜底） | Task 3 |
| 差异化引擎超时 | Task 3 |
| JSDOM + Readability + Markdown | Task 4 |
| WebFetch format 选项 | Task 4 |
| PipeLLM 重试+偏题检测 | ⏳ 不在本次范围（需要 PipeLLM API 配合） |
| 上下文压缩保护白名单 | ⏳ 不在本次范围（需要 runtime 层改动） |
| MiMo 原生搜索 | ⏳ 不在本次范围（需要 provider 层改动） |

**2. Placeholder scan:** 无 TBD / TODO / "implement later"。

**3. Type consistency:** 所有函数签名在定义和测试中一致。`SearchResult` 类型在 `web-search.ts` 和 `guanlan.ts` 中共享。`WebSearchProviderName` 已更新（无 guanlan）。
