import { describe, expect, test } from "bun:test";
import {
  isRetryablePiAiError,
  PiAiProviderError,
  resolvePiModelInput,
  resolvePiAiRetryDelayMs,
  shouldTryNextPiAiRoute,
} from "./pi-ai-provider";

describe("pi-ai image transport", () => {
  test("advertises image input when the request contains a user image", () => {
    expect(resolvePiModelInput([{
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
      ],
    }])).toEqual(["text", "image"]);
  });

  test("advertises image input when a tool result contains an image", () => {
    expect(resolvePiModelInput([{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
      }],
    }])).toEqual(["text", "image"]);
  });

  test("keeps text-only requests text-only", () => {
    expect(resolvePiModelInput([{ role: "user", content: "hello" }])).toEqual(["text"]);
  });
});

describe("pi-ai provider retry policy", () => {
  test("retries transient status and network failures only", () => {
    expect(isRetryablePiAiError(new PiAiProviderError("busy", { status: 429 }))).toBe(true);
    expect(isRetryablePiAiError(new PiAiProviderError("down", { status: 503 }))).toBe(true);
    expect(isRetryablePiAiError(new Error("fetch failed"))).toBe(true);
    expect(isRetryablePiAiError(new PiAiProviderError("invalid response payload"))).toBe(false);
    expect(isRetryablePiAiError(new PiAiProviderError("bad request", { status: 400 }))).toBe(false);
    expect(isRetryablePiAiError(new PiAiProviderError("invalid key", { status: 401 }))).toBe(false);
  });

  test("uses 1/2/4/8/16 second backoff and caps Retry-After at 120 seconds", () => {
    const deterministicRandom = () => 0.5;
    expect([0, 1, 2, 3, 4].map((index) =>
      resolvePiAiRetryDelayMs(new Error("network"), index, deterministicRandom)
    )).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(resolvePiAiRetryDelayMs(
      new PiAiProviderError("busy", { retryAfterMs: 90_000 }),
      0,
      deterministicRandom,
    )).toBe(90_000);
    expect(resolvePiAiRetryDelayMs(
      new PiAiProviderError("busy", { retryAfterMs: 300_000 }),
      0,
      deterministicRandom,
    )).toBe(120_000);
  });

  test("falls back for model-specific and credential failures but not malformed requests", () => {
    expect(shouldTryNextPiAiRoute(new PiAiProviderError("model missing", { status: 404 }), true)).toBe(true);
    expect(shouldTryNextPiAiRoute(new PiAiProviderError("invalid key", { status: 401 }), true)).toBe(true);
    expect(shouldTryNextPiAiRoute(new PiAiProviderError("bad request", { status: 400 }), true)).toBe(false);
    expect(shouldTryNextPiAiRoute(new PiAiProviderError("unprocessable", { status: 422 }), true)).toBe(false);
    expect(shouldTryNextPiAiRoute(new Error("network"), false)).toBe(false);
    expect(shouldTryNextPiAiRoute(new Error("aborted"), true, true)).toBe(false);
  });
});
