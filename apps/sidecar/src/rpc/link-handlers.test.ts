import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LinkOAuthSession } from "@lume/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkHandlers } from "./link-handlers";
import { installLinkRuntimeBootstrap } from "../services/link/link-client";

const originalFetch = globalThis.fetch;
const originalConfigDir = process.env.LUME_CONFIG_DIR;
let configDir = "";

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "lume-oauth-"));
  process.env.LUME_CONFIG_DIR = configDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  installLinkRuntimeBootstrap({ phase: "offline" });
  if (originalConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
  configDir = "";
});

describe("Link management RPC", () => {
  test("maps no-auth, API-key, and custom credentials to an exact named account", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin-only", runtimeToken: "runtime-only" });
    const requests: Array<{ authorization: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push({ authorization: request.headers.get("authorization"), body: await request.json() as Record<string, unknown> });
      return Response.json({ service: "github", connectionName: "work", configured: true, credential: "must-not-escape" });
    }) as typeof fetch;
    const handlers = createLinkHandlers(() => {});

    const result = await handlers["link:connection-upsert"]!({ service: "github", connectionName: "work", authType: "no_auth", credentials: {} });
    await handlers["link:connection-upsert"]!({ service: "github", connectionName: "work", authType: "api_key", credentials: { apiKey: "secret" } });
    await handlers["link:connection-upsert"]!({ service: "github", connectionName: "work", authType: "custom_credential", credentials: { user: "me", password: "secret" } });

    expect(requests.map((request) => request.authorization)).toEqual(["Bearer admin-only", "Bearer admin-only", "Bearer admin-only"]);
    expect(result).toEqual({ service: "github", connectionName: "work", configured: true });
    expect(requests.map((request) => request.body)).toEqual([
      { connectionName: "work", authType: "no_auth", values: {} },
      { connectionName: "work", authType: "api_key", values: { apiKey: "secret" } },
      { connectionName: "work", authType: "custom_credential", values: { user: "me", password: "secret" } },
    ]);
  });

  test("tracks OAuth pending, authorized, and cancelled state without exposing tokens", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin-only", runtimeToken: "runtime-only" });
    let connectionChecks = 0;
    let authorizationCount = 0;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/api/oauth/authorizations")) {
        authorizationCount += 1;
        return Response.json({ state: `state-${authorizationCount}`, authorizationUrl: "https://example.test/authorize" });
      }
      if (request.url.endsWith("/api/connections")) {
        connectionChecks += 1;
        return Response.json(connectionChecks === 1 ? [] : [{ service: "github", connectionName: "work", configured: true }]);
      }
      throw new Error(`unexpected request: ${request.url}`);
    }) as typeof fetch;
    const handlers = createLinkHandlers(() => {});

    const started = await handlers["link:oauth-start"]!({ service: "github", connectionName: "work" }) as LinkOAuthSession;
    expect(started).toEqual({ state: "state-1", service: "github", connectionName: "work", authorizationUrl: "https://example.test/authorize", status: "pending" });
    expect(await handlers["link:oauth-sessions"]!({})).toEqual([started]);
    expect(await handlers["link:oauth-status"]!({ state: started.state })).toMatchObject({ status: "pending" });
    expect(await handlers["link:oauth-status"]!({ state: started.state })).toMatchObject({ status: "authorized" });

    const cancelled = await handlers["link:oauth-start"]!({ service: "github", connectionName: "other" }) as LinkOAuthSession;
    expect(await handlers["link:oauth-cancel"]!({ state: cancelled.state })).toMatchObject({ status: "cancelled", connectionName: "other" });
  });

  test("forwards validated run filters and cursor pagination", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin-only", runtimeToken: "runtime-only" });
    let requestedUrl = "";
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requestedUrl = request.url;
      return Response.json({ items: [{ id: "run-1", service: "github", actionId: "github.list_repos", caller: "http", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z", durationMs: 1000, ok: false, runtimeTokenId: "must-not-escape", inputSummary: { query: "private" } }], nextCursor: "next" });
    }) as typeof fetch;
    const handlers = createLinkHandlers(() => {});

    const result = await handlers["link:runs-list"]!({ limit: 25, cursor: "opaque", service: "github", actionId: "github.list_repos", caller: "http", ok: false });

    expect(result).toEqual({ items: [{ id: "run-1", service: "github", actionId: "github.list_repos", caller: "http", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z", durationMs: 1000, ok: false }], nextCursor: "next" });
    expect(requestedUrl).toContain("/api/runs?");
    expect(requestedUrl).toContain("limit=25");
    expect(requestedUrl).toContain("cursor=opaque");
    expect(requestedUrl).toContain("service=github");
    expect(requestedUrl).toContain("actionId=github.list_repos");
    expect(requestedUrl).toContain("caller=http");
    expect(requestedUrl).toContain("ok=false");
  });

  test("survives sidecar restart by persisting pending OAuth sessions", async () => {
    installLinkRuntimeBootstrap({ phase: "online", origin: "http://127.0.0.1:51234", adminToken: "admin", runtimeToken: "runtime" });
    globalThis.fetch = (async (input) => {
      const request = new Request(input);
      if (request.url.endsWith("/api/oauth/authorizations")) return Response.json({ state: "state-1", authorizationUrl: "https://example.test/authorize" });
      if (request.url.endsWith("/api/connections")) return Response.json([]);
      throw new Error(`unexpected: ${request.url}`);
    }) as typeof fetch;
    const first = createLinkHandlers(() => {});
    await first["link:oauth-start"]!({ service: "github", connectionName: "work" });
    const restarted = createLinkHandlers(() => {});
    const sessions = await restarted["link:oauth-sessions"]!({}) as LinkOAuthSession[];
    expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ state: "state-1", service: "github", status: "pending" })]));
  });
});
