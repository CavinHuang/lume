import { describe, expect, test } from "bun:test";
import { extractArticleMarkdown, normalizeTablesHtml } from "./html-to-markdown";

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

  test("preserves GFM tables and nested cell content", () => {
    const html = `
      <html><body><article>
        <h1>Release Matrix</h1>
        <table>
          <tr><td>版本</td><td>状态</td><td>说明</td></tr>
          <tr><td>1.0</td><td><strong>稳定</strong></td><td><a href="https://example.com">文档</a></td></tr>
          <tr><td></td><td>测试中</td><td><p>包含多行</p><p>内容</p></td></tr>
        </table>
      </article></body></html>`;
    const result = extractArticleMarkdown(html, "https://example.com/table");
    expect(result).not.toBeNull();
    expect(result!.content).toContain("| 版本 | 状态 | 说明 |");
    expect(result!.content).toContain("| --- | --- | --- |");
    expect(result!.content).toContain("**稳定**");
    expect(result!.content).toContain("[文档](https://example.com/)");
    expect(result!.content).toContain("包含多行");
  });

  test("expands merged table cells without dropping surrounding rows", () => {
    const html = `<article><table>
      <tr><th colspan="2">标题</th></tr>
      <tr><td rowspan="2">分类</td><td>A</td></tr>
      <tr><td>B</td></tr>
    </table></article>`;
    const result = extractArticleMarkdown(html, "https://example.com/merged");
    expect(result).not.toBeNull();
    expect(result!.content).toContain("标题");
    expect(result!.content).toContain("分类");
    expect(result!.content).toContain("A");
    expect(result!.content).toContain("B");
  });

  test("caps hostile rowspan/colspan expansion (#303)", () => {
    const html = `<article><table>
      <tr><td rowspan="99999999" colspan="99999999">x</td></tr>
    </table></article>`;
    const result = extractArticleMarkdown(html, "https://example.com/hostile");
    expect(result).not.toBeNull();
    // Expansion is capped: a bounded grid instead of a hostile allocation.
    expect(result!.content.split("\n").length).toBeLessThan(250);
  });
});

describe("normalizeTablesHtml span budgets (#303)", () => {
  test("absurd rowspan/colspan attributes are clamped and cannot explode the grid", () => {
    const html = `<table><tr><td rowspan="99999999" colspan="99999999">x</td></tr></table>`;
    const out = normalizeTablesHtml(html);
    expect(out).toContain("x");
    expect(out).not.toContain("rowspan");
    expect(out.length).toBeLessThan(500_000); // clamped to a 100×100 grid, not millions of cells
  });

  test("a table whose clamped expansion exceeds the cell budget is left untouched", () => {
    // 30 cells × (100×100) = 300,000 grid slots, past the 250k budget → skip normalization
    const cells = Array.from({ length: 30 }, (_, i) => `<td rowspan="100" colspan="100">c${i}</td>`).join("");
    const html = `<table><tr>${cells}</tr></table>`;
    const out = normalizeTablesHtml(html);
    expect(out).toContain('rowspan="100"');
    expect(out).toContain('colspan="100"');
  });

  test("large-but-legal merged grids still expand", () => {
    const html = `<table><tr><td rowspan="50" colspan="50">cell</td></tr></table>`;
    const out = normalizeTablesHtml(html);
    expect(out).not.toContain("rowspan");
    expect(out).not.toContain("colspan");
  });
});

describe("document-level span budget (#458)", () => {
  // Each table expands to a legal 10,000-cell grid (single-table budget intact).
  const smallTable = (label: string) =>
    `<table><tr><td rowspan="100" colspan="100">${label}</td></tr></table>`;

  test("many legal small tables cannot stack expansions past the document budget", () => {
    // 25 tables fill the document budget exactly; the 26th must be skipped.
    const tables = Array.from({ length: 26 }, (_, i) => smallTable(`t${i}`)).join("");
    const out = normalizeTablesHtml(tables);
    expect(out).toContain("t0");
    expect(out).toContain("t25"); // skipped table's content is kept, not dropped
    expect(out).toContain("[table span budget reached: 1 table(s) left unnormalized]");
    expect(out.split('rowspan="100"').length - 1).toBe(1); // only the skipped table keeps its spans
  }, 120_000);

  test("tables exactly filling the document budget still all expand", () => {
    const tables = Array.from({ length: 25 }, (_, i) => smallTable(`t${i}`)).join("");
    const out = normalizeTablesHtml(tables);
    expect(out).not.toContain("rowspan");
    expect(out).not.toContain("colspan");
    expect(out).not.toContain("table span budget");
  }, 120_000);

  test("a per-table over-budget table is also reported by the truncation marker", () => {
    const cells = Array.from({ length: 30 }, (_, i) => `<td rowspan="100" colspan="100">c${i}</td>`).join("");
    const out = normalizeTablesHtml(`<p>intro</p><table><tr>${cells}</tr></table>`);
    expect(out).toContain('rowspan="100"');
    expect(out).toContain("[table span budget reached: 1 table(s) left unnormalized]");
  });
});
