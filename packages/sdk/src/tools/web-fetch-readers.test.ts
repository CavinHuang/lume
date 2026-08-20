import { describe, expect, test } from "bun:test";
import { renderHtmlToMarkdown, type ReaderContext } from "./web-fetch-readers.js";

function makeContext(overrides: Partial<ReaderContext>): ReaderContext {
  return {
    url: "https://docs.example.com/x",
    html: "<html><body></body></html>",
    timeoutMs: 2000,
    fetchImpl: async () => new Response("unused", { status: 404 }),
    toolContext: { cwd: process.cwd() },
    ...overrides,
  } as ReaderContext;
}

describe("reader proxy domain whitelist (#200)", () => {
  test("jina reader refuses to proxy-fetch a target the sandbox denies", async () => {
    const fetched: string[] = [];
    const context = makeContext({
      url: "http://169.254.169.254/admin",
      sandbox: {
        enabled: true,
        network: { allowedDomains: ["r.jina.ai"] },
      },
      fetchImpl: async (url: string) => {
        fetched.push(String(url));
        return new Response("# proxied secret", { headers: { "content-type": "text/markdown" } });
      },
    });

    const result = await renderHtmlToMarkdown(context, "jina");
    expect(result).toBeNull();
    expect(fetched).toEqual([]);
  });

  test("jina reader proceeds when both the proxy and the target are allowed", async () => {
    const fetched: string[] = [];
    const longMarkdown = "# Doc\n\n" + "proxied content line long enough to pass the low-quality heuristic\n".repeat(40);
    const context = makeContext({
      sandbox: {
        enabled: true,
        network: { allowedDomains: ["r.jina.ai", "docs.example.com"] },
      },
      fetchImpl: async (url: string) => {
        fetched.push(String(url));
        return new Response(longMarkdown, { headers: { "content-type": "text/markdown" } });
      },
    });

    const result = await renderHtmlToMarkdown(context, "jina");
    expect(result?.method).toBe("jina");
    expect(fetched.length).toBeGreaterThanOrEqual(1);
    expect(fetched[0]).toContain("r.jina.ai/");
  });
});
