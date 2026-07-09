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
