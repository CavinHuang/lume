import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChannelDirect } from "./channel-manager";

const originalFetch = globalThis.fetch;
let previousConfigDir: string | undefined;
let directory = "";

beforeEach(() => {
  previousConfigDir = process.env.LUME_CONFIG_DIR;
  directory = mkdtempSync(join(tmpdir(), "lume-connection-test-"));
  process.env.LUME_CONFIG_DIR = directory;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = previousConfigDir;
  rmSync(directory, { recursive: true, force: true });
});

describe("connection test", () => {
  test("validates Anthropic credentials through the model catalog without creating a paid message", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(testChannelDirect({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
    })).resolves.toMatchObject({ success: true, message: "连接成功" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  test("keeps Google API keys out of request URLs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(testChannelDirect({
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "google-secret",
    })).resolves.toMatchObject({ success: true });

    expect(requests[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(new Headers(requests[0]?.init?.headers).get("x-goog-api-key")).toBe("google-secret");
  });
});
