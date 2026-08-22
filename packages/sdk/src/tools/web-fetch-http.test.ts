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

  test("denies private-network IP literals before any fetch (#206)", async () => {
    const fetched: string[] = [];
    const result = await loadPage("http://169.254.169.254/latest/meta-data/", {
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return new Response("secret");
      },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Sandbox denied");
    expect(fetched).toEqual([]);
  });

  test("user-allowed domains keep an explicitly permitted private host reachable (#206)", async () => {
    const fetched: string[] = [];
    const result = await loadPage("http://10.0.0.5/@user", {
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
      sandbox: { enabled: true, network: { allowedDomains: ["10.0.0.5"] } },
      timeoutMs: 1000,
    });
    expect(fetched).toEqual(["http://10.0.0.5/@user"]);
    expect(result.ok).toBe(true);
  });

  test("strips Authorization when a redirect crosses origins (#207)", async () => {
    const authHeaders: string[] = [];
    let hop = 0;
    const result = await loadPage("https://api.example.com/logs", {
      fetchImpl: async (_url, init) => {
        hop += 1;
        authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
        if (hop === 1) return new Response("", { status: 302, headers: { location: "https://cdn.example.net/logs" } });
        return new Response("logs", { status: 200, headers: { "content-type": "text/plain" } });
      },
      headers: { Authorization: "Bearer secret-token" },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(authHeaders).toEqual(["Bearer secret-token", ""]);
  });

  test("keeps Authorization when a redirect stays same-origin (#207)", async () => {
    const authHeaders: string[] = [];
    let hop = 0;
    const result = await loadPage("https://api.example.com/logs", {
      fetchImpl: async (_url, init) => {
        hop += 1;
        authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
        if (hop === 1) return new Response("", { status: 302, headers: { location: "https://api.example.com/logs?page=2" } });
        return new Response("logs", { status: 200, headers: { "content-type": "text/plain" } });
      },
      headers: { Authorization: "Bearer secret-token" },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(authHeaders).toEqual(["Bearer secret-token", "Bearer secret-token"]);
  });
});
