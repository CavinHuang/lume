import { describe, expect, spyOn, test } from "bun:test";
import { parseMarkdownFrontmatter } from "./markdown-frontmatter.js";

describe("parseMarkdownFrontmatter list values (#350)", () => {
  test("parses indented list items", () => {
    const parsed = parseMarkdownFrontmatter(
      "---\nname: demo\nallowedTools:\n  - Read\n  - Write\n---\nbody",
    );
    expect(parsed.frontmatter.allowedTools).toBe("Read,Write");
    expect(parsed.frontmatter.name).toBe("demo");
    expect(parsed.content).toBe("body");
  });

  test("parses top-level (unindented) list items per standard YAML", () => {
    const parsed = parseMarkdownFrontmatter(
      "---\nallowedTools:\n- Read\n- mcp__x__*\n---\nbody",
    );
    expect(parsed.frontmatter.allowedTools).toBe("Read,mcp__x__*");
    expect(parsed.content).toBe("body");
  });

  test("accepts mixed indentation", () => {
    const parsed = parseMarkdownFrontmatter("---\nlist:\n- one\n  - two\n---\nbody");
    expect(parsed.frontmatter.list).toBe("one,two");
  });

  test("stops at the next key-shaped line and keeps parsing it", () => {
    const parsed = parseMarkdownFrontmatter(
      "---\nallowedTools:\n- Read\nname: demo\n---\nbody",
    );
    expect(parsed.frontmatter.allowedTools).toBe("Read");
    expect(parsed.frontmatter.name).toBe("demo");
    expect(parsed.content).toBe("body");
  });

  test("stops at the closing fence", () => {
    const parsed = parseMarkdownFrontmatter(
      "---\nallowedTools:\n- Read\n---\n- not a list item",
    );
    expect(parsed.frontmatter.allowedTools).toBe("Read");
    expect(parsed.content).toBe("- not a list item");
  });

  test("warns when a list-valued key has no items", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const parsed = parseMarkdownFrontmatter(
        "---\nallowedTools:\nsomekey: value\n---\nbody",
      );
      expect(parsed.frontmatter.allowedTools).toBe("");
      expect(parsed.frontmatter.somekey).toBe("value");
      expect(warn.mock.calls.some((call) => String(call[0]).includes("allowedTools"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
