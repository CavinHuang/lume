import { describe, expect, test } from "bun:test";
import { withRetry } from "./retry.js";

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
});
