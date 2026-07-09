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
