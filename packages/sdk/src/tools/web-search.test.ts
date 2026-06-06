import { describe, expect, test } from "bun:test";
import {
  parseGuanlanSearchOutput,
  resolveEnabledWebSearchProviders,
  detectAcceptLanguage
} from "./web-search";

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
