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

describe("runWebFetch — content types", () => {
  test("returns a direct image as an image content block", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
    const fetchImpl = (async () => new Response(png, { headers: { "content-type": "image/png" } })) as any;
    const out = await runWebFetch({ url: "https://example.com/pixel.png" }, ctx, { fetchImpl });
    expect(out.is_error).toBeFalsy();
    expect((out.data as any).content[0].type).toBe("image");
    expect((out.data as any).content[0].mimeType).toBe("image/png");
  });

  test("prefers a declared Markdown alternate", async () => {
    const markdown = "# Alternate\n\n" + "content ".repeat(40);
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/article.md")) return new Response(markdown, { headers: { "content-type": "text/markdown" } });
      return new Response(`<html><head><link rel="alternate" type="text/markdown" href="/article.md"></head><body><article>${"fallback ".repeat(50)}</article></body></html>`, { headers: { "content-type": "text/html" } });
    }) as any;
    const out = await runWebFetch({ url: "https://example.com/article" }, ctx, { fetchImpl });
    expect(out.data).toContain("Alternate");
    expect(out.data).toContain("alternate-markdown");
  });

  test("converts RSS items to Markdown", async () => {
    const feed = `<rss><channel><title>News</title><item><title>First</title><link>https://example.com/first</link><description>Hello feed</description></item></channel></rss>`;
    const fetchImpl = (async () => new Response(feed, { headers: { "content-type": "application/rss+xml" } })) as any;
    const out = await runWebFetch({ url: "https://example.com/feed.xml" }, ctx, { fetchImpl });
    expect(out.data).toContain("## First");
    expect(out.data).toContain("Hello feed");
  });
});
