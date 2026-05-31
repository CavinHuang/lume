import { describe, expect, test } from "bun:test";
import {
  parseGuanlanSearchOutput,
  resolveEnabledWebSearchProviders
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
