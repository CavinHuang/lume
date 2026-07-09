// packages/sdk/src/tools/render-client.test.ts
import { describe, expect, test } from "bun:test";
import { createNoopRenderClient } from "./render-client.js";

describe("createNoopRenderClient", () => {
  test("returns render_unavailable outcome without throwing", async () => {
    const client = createNoopRenderClient();
    const out = await client.renderUrl("https://example.com");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("render_unavailable");
      expect(out.error.message).toMatch(/render/i);
    }
  });

  test("exposes renderUrl as a function", () => {
    const client = createNoopRenderClient();
    expect(typeof client.renderUrl).toBe("function");
  });
});
