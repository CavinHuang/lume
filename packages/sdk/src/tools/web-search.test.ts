import { describe, expect, test } from "bun:test";
import {
  parseGuanlanSearchOutput,
  resolveEnabledWebSearchProviders,
  detectAcceptLanguage,
  isBingBlockedPage,
  parseBingResultItem,
  clampProviderLimit,
  WebSearchTool,
  ENGINE_TIMEOUT_MS
} from "./web-search";
import type { WebSearchProviderName } from "./web-search";

describe("web-search provider config", () => {
  test("未配置 provider env 时保留默认 fallback 顺序", () => {
    expect(resolveEnabledWebSearchProviders(undefined)).toEqual([
      "guanlan",
      "exa",
      "pipellm",
      "zhipu",
      "tavily",
      "brave",
      "duckduckgo",
      "bing"
    ]);
  });

  test("按 env 启用顺序解析 provider 并忽略未知值", () => {
    expect(resolveEnabledWebSearchProviders("guanlan,bing,unknown,duckduckgo")).toEqual([
      "guanlan",
      "bing",
      "duckduckgo"
    ]);
  });

  test("显式空 provider env 表示不启用搜索后端", () => {
    expect(resolveEnabledWebSearchProviders("")).toEqual([]);
  });
});

describe("guanlan result parsing", () => {
  test("解析 results 包裹的 guanlan JSON 输出", () => {
    expect(parseGuanlanSearchOutput(JSON.stringify({
      results: [
        {
          title: "标题",
          url: "https://example.com",
          snippet: "摘要"
        }
      ]
    }))).toEqual([
      {
        title: "标题",
        url: "https://example.com",
        snippet: "摘要"
      }
    ]);
  });

  test("过滤缺少标题或 URL 的结果", () => {
    expect(parseGuanlanSearchOutput(JSON.stringify([
      { title: "无 URL" },
      { url: "https://example.com/no-title" },
      { title: "有效", url: "https://example.com/ok" }
    ]))).toEqual([
      { title: "有效", url: "https://example.com/ok" }
    ]);
  });
});

describe("detectAcceptLanguage", () => {
  test("returns zh-CN for Chinese queries", () => {
    expect(detectAcceptLanguage("中国经济政策")).toBe("zh-CN,zh;q=0.9,en;q=0.8");
  });

  test("returns ko-KR for Korean queries", () => {
    expect(detectAcceptLanguage("한국 경제")).toBe("ko-KR,ko;q=0.9,en;q=0.8");
  });

  test("returns ja-JP for Japanese queries", () => {
    expect(detectAcceptLanguage("日本の経済")).toBe("ja-JP,ja;q=0.9,en;q=0.8");
  });

  test("returns en-US for plain ASCII queries", () => {
    expect(detectAcceptLanguage("hello world")).toBe("en-US,en;q=0.9");
  });

  test("returns zh-CN as default for mixed CJK", () => {
    expect(detectAcceptLanguage("test 中文混合")).toBe("zh-CN,zh;q=0.9,en;q=0.8");
  });
});

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

describe("engine timeout config", () => {
  test("each engine has an explicit timeout configured", () => {
    const names: WebSearchProviderName[] = ["exa", "pipellm", "zhipu", "tavily", "brave", "duckduckgo", "bing", "guanlan"];
    for (const name of names) {
      expect(ENGINE_TIMEOUT_MS[name]).toBeGreaterThan(0);
    }
    expect(ENGINE_TIMEOUT_MS.tavily).toBeGreaterThan(ENGINE_TIMEOUT_MS.brave);
  });
});

describe("num_results clamping (#220)", () => {
  test("clamps num_results to 1..10 with a default of 5", () => {
    expect(clampProviderLimit(100000)).toBe(10);
    expect(clampProviderLimit(0)).toBe(5);
    expect(clampProviderLimit(-3)).toBe(1);
    expect(clampProviderLimit(3.7)).toBe(3);
    expect(clampProviderLimit(Number.NaN)).toBe(5);
  });
});

describe("WebSearchTool input validation (#220)", () => {
  test("rejects missing or non-string query", async () => {
    for (const input of [{}, { query: "" }, { query: "  " }, { query: 42 }]) {
      const out = await WebSearchTool.call(input as any, { sandbox: undefined } as any);
      expect(out.is_error).toBe(true);
      expect((out.content as string).toLowerCase()).toContain("query is required");
    }
  });

  test("rejects non-number num_results", async () => {
    const out = await WebSearchTool.call({ query: "lume", num_results: "10" } as any, { sandbox: undefined } as any);
    expect(out.is_error).toBe(true);
    expect((out.content as string).toLowerCase()).toContain("num_results must be a number");
  });
});
