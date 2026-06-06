import { describe, expect, test } from "bun:test";
import {
  buildGuanlanHotnewsArgs,
  buildGuanlanReadArgs,
  buildGuanlanResearchArgs,
  buildGuanlanSearchArgs,
  GuanlanHotnewsTool,
  GuanlanReadTool,
  GuanlanResearchTool,
  GuanlanSearchTool,
} from "./guanlan.js";

describe("Guanlan tools", () => {
  test("builds Guanlan CLI args with Alice-compatible subcommands", () => {
    expect(buildGuanlanSearchArgs({
      query: "中文搜索",
      profile: "china",
      max_results: 80,
      scope: "news",
      site: "example.com"
    })).toEqual([
      "search", "中文搜索",
      "--profile", "china",
      "--limit", "50",
      "--json",
      "--scope", "news",
      "--site", "example.com"
    ]);

    expect(buildGuanlanReadArgs({
      url: "https://example.com",
      max_chars: 60000,
      strict: true
    })).toEqual([
      "read", "https://example.com",
      "--max-chars", "50000",
      "--strict"
    ]);

    expect(buildGuanlanHotnewsArgs({ source: "weibo", limit: 2, trends: true })).toEqual([
      "hotnews", "weibo",
      "--limit", "2",
      "--brief",
      "--trends"
    ]);

    expect(buildGuanlanResearchArgs({
      query: "AI Agent 中文互联网",
      profile: "global",
      read_top: 9,
      preset: "deep"
    })).toEqual([
      "research", "AI Agent 中文互联网",
      "--profile", "global",
      "--read-top", "5",
      "--format", "markdown",
      "--preset", "deep"
    ]);
  });

  test("exposes read-only non-concurrency-safe runtime metadata", () => {
    for (const tool of [
      GuanlanSearchTool,
      GuanlanReadTool,
      GuanlanHotnewsTool,
      GuanlanResearchTool
    ]) {
      expect(tool.isReadOnly?.()).toBeTrue();
      expect(tool.isConcurrencySafe?.()).toBeFalse();
      expect(tool.runtimeMetadata).toMatchObject({
        category: "network",
        capability: "web",
        riskLevel: "low",
        allowedInPlanMode: true,
        isReadOnly: true,
        isConcurrencySafe: false,
        requiresApprovalByDefault: false
      });
    }
    expect(GuanlanSearchTool.runtimeMetadata?.executionPolicy).toEqual({ maxCallsPerTurn: 8 });
  });
});
