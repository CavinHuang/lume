// packages/sdk/src/tools/image-pipeline.test.ts
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { resolveImgSrc, downloadAndLocalizeImages, lumeFileUrl, fetchIdFromUrl } from "./image-pipeline.js";

describe("lumeFileUrl", () => {
  test("encodes absolute path into lume-file URL", () => {
    expect(lumeFileUrl("/home/u/.lume/agent-workspaces/a/resources/fetches/abc/images/x.png"))
      .toBe("lume-file://file/" + encodeURIComponent("/home/u/.lume/agent-workspaces/a/resources/fetches/abc/images/x.png"));
  });
});

describe("fetchIdFromUrl", () => {
  test("returns 8-hex prefix of sha256(url), stable for same url", () => {
    const id = fetchIdFromUrl("https://mp.weixin.qq.com/s/yIWl8Yv4T2QRUg446UEKeQ");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(fetchIdFromUrl("https://mp.weixin.qq.com/s/yIWl8Yv4T2QRUg446UEKeQ")).toBe(id);
  });
  test("differs for different urls", () => {
    expect(fetchIdFromUrl("https://a.com")).not.toBe(fetchIdFromUrl("https://b.com"));
  });
});

describe("resolveImgSrc", () => {
  const dom = (html: string) => new JSDOM(html).window.document;
  test("uses src when present", () => {
    const img = dom(`<img src="https://a.com/1.png">`).querySelector("img")!;
    expect(resolveImgSrc(img as any)).toBe("https://a.com/1.png");
  });
  test("falls back to data-src for lazy-loaded images", () => {
    const img = dom(`<img data-src="https://a.com/2.png">`).querySelector("img")!;
    expect(resolveImgSrc(img as any)).toBe("https://a.com/2.png");
  });
  test("falls back to data-original then data-lazy-src", () => {
    const img1 = dom(`<img data-original="https://a.com/3.png">`).querySelector("img")!;
    const img2 = dom(`<img data-lazy-src="https://a.com/4.png">`).querySelector("img")!;
    expect(resolveImgSrc(img1 as any)).toBe("https://a.com/3.png");
    expect(resolveImgSrc(img2 as any)).toBe("https://a.com/4.png");
  });
  test("returns null when no usable source", () => {
    const img = dom(`<img alt="no src">`).querySelector("img")!;
    expect(resolveImgSrc(img as any)).toBeNull();
  });
  test("uses picture source and data-srcset fallbacks", () => {
    const img = dom(`<picture><source data-srcset="https://a.com/large.webp 2x"><img src="data:," /></picture>`).querySelector("img")!;
    expect(resolveImgSrc(img as any)).toBe("https://a.com/large.webp");
  });
});

describe("downloadAndLocalizeImages", () => {
  test("download mode: fetches with Referer=page origin, writes hash-named file, rewrites src to lume-file", async () => {
    const tmp = await import("node:fs/promises");
    const dir = await tmp.mkdtemp((await import("node:os")).tmpdir() + "/lume-img-");
    const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (url: string, init?: any) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return new Response(png1x1, { status: 200, headers: { "content-type": "image/png" } });
    }) as any;

    const html = `<img data-src="//mmbiz.qpic.cn/a.png">`;
    const out = await downloadAndLocalizeImages(html, "https://mp.weixin.qq.com/s/abc", dir, "download", fakeFetch);

    expect(calls[0].url).toBe("https://mmbiz.qpic.cn/a.png");
    expect(calls[0].headers["Referer"]).toBe("https://mp.weixin.qq.com/");
    expect(out.downloaded).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.html).toContain("lume-file://file/");
    // file written with .png extension
    const files = await tmp.readdir(dir);
    expect(files.some((f) => f.endsWith(".png"))).toBe(true);
    await tmp.rm(dir, { recursive: true, force: true });
  });

  test("keep mode: only rewrites src to absolute URL, does not fetch", async () => {
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => { fetched.push(url); return new Response(Buffer.from("x")); }) as any;
    const out = await downloadAndLocalizeImages(`<img data-src="/img/a.png">`, "https://example.com/page", "/tmp/none", "keep", fakeFetch);
    expect(fetched.length).toBe(0);
    expect(out.html).toContain('src="https://example.com/img/a.png"');
  });

  test("download failure degrades to original URL, counts failed", async () => {
    const fakeFetch = (async () => new Response("", { status: 403 })) as any;
    const out = await downloadAndLocalizeImages(`<img src="https://a.com/x.png">`, "https://example.com", "/tmp/none", "download", fakeFetch);
    expect(out.failed).toBe(1);
    expect(out.downloaded).toBe(0);
    expect(out.html).toContain("https://a.com/x.png");
  });

  test("sandbox enabled + non-allowed image host: skipped, no fetch, src stays original URL", async () => {
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => { fetched.push(url); return new Response(Buffer.from("x")); }) as any;
    const sandbox = { enabled: true, network: { allowedDomains: ["example.com"] } };
    const html = `<img src="https://evil.com/steal.png">`;
    const out = await downloadAndLocalizeImages(html, "https://example.com/page", "/tmp/none", "download", fakeFetch, sandbox);
    expect(fetched.length).toBe(0);
    expect(out.downloaded).toBe(0);
    expect(out.failed).toBe(1);
    expect(out.html).toContain("https://evil.com/steal.png");
  });

  test("same-origin image still downloads under strict sandbox", async () => {
    const tmp = await import("node:fs/promises");
    const dir = await tmp.mkdtemp((await import("node:os")).tmpdir() + "/lume-img-");
    const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => { fetched.push(url); return new Response(png1x1, { status: 200, headers: { "content-type": "image/png" } }); }) as any;
    const sandbox = { enabled: true, network: { allowedDomains: ["example.com"] } };
    const html = `<img src="https://example.com/img/a.png">`;
    const out = await downloadAndLocalizeImages(html, "https://example.com/page", dir, "download", fakeFetch, sandbox);
    expect(fetched.length).toBe(1);
    expect(fetched[0]).toBe("https://example.com/img/a.png");
    expect(out.downloaded).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.html).toContain("lume-file://file/");
    await tmp.rm(dir, { recursive: true, force: true });
  });

  test("mmbiz whitelisted host downloads under strict sandbox (CDN whitelist)", async () => {
    const tmp = await import("node:fs/promises");
    const dir = await tmp.mkdtemp((await import("node:os")).tmpdir() + "/lume-img-");
    const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => { fetched.push(url); return new Response(png1x1, { status: 200, headers: { "content-type": "image/png" } }); }) as any;
    // mmbiz.qpic.cn is NOT in allowedDomains and NOT same-origin as example.com,
    // but is in the CDN whitelist → must still download.
    const sandbox = { enabled: true, network: { allowedDomains: ["example.com"] } };
    const html = `<img src="https://mmbiz.qpic.cn/mmblog/a.png">`;
    const out = await downloadAndLocalizeImages(html, "https://example.com/page", dir, "download", fakeFetch, sandbox);
    expect(fetched.length).toBe(1);
    expect(fetched[0]).toBe("https://mmbiz.qpic.cn/mmblog/a.png");
    expect(out.downloaded).toBe(1);
    expect(out.failed).toBe(0);
    await tmp.rm(dir, { recursive: true, force: true });
  });
});
