import { describe, expect, test } from "bun:test";
import { llmCandidates, runWebFetch } from "./web-fetch.js";
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

describe("run-level deadline and probe budget (#373)", () => {
  test("llms.txt candidates are capped for deep paths", () => {
    expect(llmCandidates("https://a.com/x/y/z/w/v/u/t/deep").length).toBeLessThanOrEqual(6);
    expect(llmCandidates("https://a.com/")).toHaveLength(3);
  });

  test("once the deadline is spent, speculative probes are skipped entirely", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 120));
      return new Response(fakeArticleHtml("word ".repeat(40)), { headers: { "content-type": "text/html" } });
    }) as any;
    const slowCtx = { sandbox: undefined, toolConfig: { webFetch: { timeoutMs: 400 } } } as any;
    const out = await runWebFetch({ url: "https://slow.example/a" }, slowCtx, { fetchImpl });
    expect(out.is_error).toBeFalsy();
    // Only the primary request may fire; .md / content-negotiation / llms.txt
    // probes must be skipped once the deadline leaves no usable budget.
    expect(urls.every((url) => url === "https://slow.example/a")).toBe(true);
  });

  test("with a healthy budget the speculative probes still run", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      if (!String(url).endsWith("/a")) return new Response("not found", { status: 404 });
      return new Response(fakeArticleHtml("word ".repeat(40)), { headers: { "content-type": "text/html" } });
    }) as any;
    const out = await runWebFetch({ url: "https://probe.example/a" }, ctx, { fetchImpl });
    expect(out.is_error).toBeFalsy();
    expect(urls.some((url) => url.endsWith(".md"))).toBe(true);
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

  test("images above the inline threshold are saved to the asset dir instead of base64 (#372)", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lume-wf-img-"));
    try {
      const bigPng = Buffer.alloc(5 * 1024 * 1024 + 1, 1); // just past the inline threshold
      const fetchImpl = (async () => new Response(bigPng, { headers: { "content-type": "image/png" } })) as any;
      const out = await runWebFetch(
        { url: "https://example.com/huge.png" },
        ctx,
        { fetchImpl, resolveAssetDir: () => dir },
      );
      expect(typeof out.data).toBe("string");
      expect(out.data as string).toContain("too large to inline");
      expect(out.data as string).toContain("lume-file://file/");
      const imagesDir = path.join(dir, "images");
      const files = await fs.readdir(imagesDir);
      expect(files.some((f) => f.endsWith(".png"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("an oversized image with no asset dir degrades to text instead of base64 (#372)", async () => {
    const bigPng = Buffer.alloc(6 * 1024 * 1024, 1);
    const fetchImpl = (async () => new Response(bigPng, { headers: { "content-type": "image/png" } })) as any;
    const out = await runWebFetch({ url: "https://example.com/huge.png" }, ctx, { fetchImpl });
    expect(out.is_error).toBeFalsy();
    expect(typeof out.data).toBe("string");
    expect(out.data as string).toContain("too large to inline");
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

  test("html format output is truncated like markdown (#219)", async () => {
    const fetchImpl = (async () => new Response(`<html><body>${"x".repeat(150000)}</body></html>`, { headers: { "content-type": "text/html" } })) as any;
    const out = await runWebFetch({ url: "https://example.com/big", format: "html" }, ctx, { fetchImpl });
    expect(out.is_error).toBeFalsy();
    expect((out.data as string).length).toBeLessThanOrEqual(100000 + "\n\n[content truncated]".length);
    expect(out.data).toContain("[content truncated]");
  });

  test("image binary fetch failure is an error, not a success (#219)", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response(png, { headers: { "content-type": "image/png" } });
      return new Response("boom", { status: 500 });
    }) as any;
    const out = await runWebFetch({ url: "https://example.com/pixel.png" }, ctx, { fetchImpl });
    expect(out.is_error).toBe(true);
    expect(out.data).toContain("Image fetch failed");
  });

  test("structured binary fetch failure is an error, not a success (#219)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response("PK", { headers: { "content-type": "application/zip" } });
      return new Response("boom", { status: 500 });
    }) as any;
    const out = await runWebFetch({ url: "https://example.com/a.zip" }, ctx, { fetchImpl });
    expect(out.is_error).toBe(true);
    expect(out.data).toContain("zip resource");
  });
});
