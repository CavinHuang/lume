import { describe, expect, test } from "bun:test";
import { loadPage } from "./web-fetch-http.js";

describe("loadPage", () => {
  test("retries a 429 once and preserves the successful result", async () => {
    let calls = 0;
    const result = await loadPage("https://example.com", {
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? new Response("busy", { status: 429, headers: { "retry-after": "0" } })
          : new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("ok");
    expect(calls).toBe(2);
  });

  test("rotates user agents for bot challenge responses", async () => {
    const agents: string[] = [];
    const result = await loadPage("https://example.com", {
      fetchImpl: async (_url, init) => {
        agents.push(new Headers(init?.headers).get("user-agent") || "");
        return agents.length === 1
          ? new Response("Cloudflare challenge", { status: 403 })
          : new Response("article", { status: 200, headers: { "content-type": "text/plain" } });
      },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(new Set(agents).size).toBe(2);
  });

  test("decodes a declared non-UTF8 charset", async () => {
    const bytes = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
    const result = await loadPage("https://example.com", {
      fetchImpl: async () => new Response(bytes, { headers: { "content-type": "text/plain; charset=windows-1252" } }),
      timeoutMs: 1000,
    });
    expect(result.content).toBe("café");
  });

  test("checks every redirect against the network sandbox", async () => {
    const result = await loadPage("https://example.com/start", {
      fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://evil.example/next" } }),
      sandbox: { enabled: true, network: { allowedDomains: ["example.com"] } },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Sandbox denied");
  });

  test("rejects responses larger than the configured limit before reading the body", async () => {
    const result = await loadPage("https://example.com", {
      fetchImpl: async () => new Response("too large", { headers: { "content-length": "100" } }),
      maxBytes: 10,
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exceeds 10 bytes");
  });
});
