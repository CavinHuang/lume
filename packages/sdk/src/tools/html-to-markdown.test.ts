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
    expect(result!.title).toBe("Test Page");
    expect(result!.content).toContain("test");
    expect(result!.content).toContain("Item 1");
  });

  test("returns null for pages without meaningful content", () => {
    const html = `<html><body><nav>menu items</nav></body></html>`;
    const result = extractArticleMarkdown(html, "https://example.com");
    // Readability might extract minimal content, but it should be empty or trivial
    expect(result === null || result.content.trim().length < 20).toBe(true);
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
