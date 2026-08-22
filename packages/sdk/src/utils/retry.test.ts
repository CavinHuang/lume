import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETRY_CONFIG,
  MAX_RETRY_AFTER_DELAY_MS,
  computeRetryDelay,
  parseRetryAfterHeader,
  withRetry,
} from "./retry.js";

function rateLimitError(): Error & { status: number } {
  const err = new Error("rate limited") as Error & { status: number };
  err.status = 429;
  return err;
}

const slowBackoff = { maxRetries: 5, baseDelayMs: 30_000, maxDelayMs: 30_000, retryableStatusCodes: [429] };

describe("withRetry", () => {
  test("rejects during backoff sleep when aborted, without waiting it out (#231)", async () => {
    const controller = new AbortController();
    const attempts: number[] = [];

    const pending = withRetry(
      () => {
        attempts.push(Date.now());
        throw rateLimitError();
      },
      slowBackoff,
      controller.signal,
    );
    controller.abort();
    const began = Date.now();

    await expect(pending).rejects.toThrow("Aborted");
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  test("still retries retryable errors when nothing aborts", async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts += 1;
        if (attempts < 2) throw rateLimitError();
        return Promise.resolve("ok");
      },
      { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2, retryableStatusCodes: [429] },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("honors err.retryAfterMs instead of long exponential backoff (#351)", async () => {
    let attempts = 0;
    const began = Date.now();
    const result = await withRetry(
      () => {
        attempts += 1;
        if (attempts < 2) {
          const err: any = rateLimitError();
          err.retryAfterMs = 5;
          throw err;
        }
        return Promise.resolve("ok");
      },
      slowBackoff,
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(Date.now() - began).toBeLessThan(5_000);
  });
});

describe("parseRetryAfterHeader (#351)", () => {
  test("parses delta-seconds values", () => {
    expect(parseRetryAfterHeader("30")).toBe(30_000);
    expect(parseRetryAfterHeader("0")).toBe(0);
    expect(parseRetryAfterHeader("-5")).toBe(0);
  });

  test("parses HTTP-date values relative to now", () => {
    const parsed = parseRetryAfterHeader(new Date(Date.now() + 10_000).toUTCString());
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(10_000);
    expect(parseRetryAfterHeader(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  test("returns undefined for absent or garbage values", () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader(undefined)).toBeUndefined();
    expect(parseRetryAfterHeader("n/a")).toBeUndefined();
  });
});

describe("computeRetryDelay (#351)", () => {
  const config = { ...DEFAULT_RETRY_CONFIG };

  test("prefers the server-provided retryAfterMs without jitter", () => {
    expect(computeRetryDelay({ retryAfterMs: 7_000 }, 0, config)).toBe(7_000);
  });

  test("clamps retryAfterMs to the hard cap and floors negatives", () => {
    expect(computeRetryDelay({ retryAfterMs: 500_000 }, 0, config)).toBe(MAX_RETRY_AFTER_DELAY_MS);
    expect(computeRetryDelay({ retryAfterMs: -5 }, 0, config)).toBe(0);
    expect(computeRetryDelay({ retryAfterMs: Number.NaN }, 0, config)).toBeLessThanOrEqual(config.maxDelayMs);
  });

  test("falls back to exponential backoff when no header was present", () => {
    const delay = computeRetryDelay(new Error("plain"), 0, config);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(config.maxDelayMs);
  });
});
