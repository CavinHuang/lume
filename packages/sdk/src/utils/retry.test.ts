import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETRY_CONFIG,
  MAX_RETRY_AFTER_DELAY_MS,
  computeRetryDelay,
  isPromptTooLongError,
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

describe("isPromptTooLongError widened recognition (#567 item 1)", () => {
  test("413 without an HTML body enters recovery", () => {
    expect(isPromptTooLongError({ status: 413, message: "Payload Too Large" })).toBe(true);
  });

  test("structured OpenAI-style code wins over wording", () => {
    expect(isPromptTooLongError({ status: 400, error: { error: { code: "context_length_exceeded" } } })).toBe(true);
  });

  test("gateway-rephrased messages are recognized", () => {
    for (const message of [
      "maximum context length of 32768 tokens exceeded",
      "This model's maximum context length is 8192 tokens",
      "input is too long for the requested model",
      "prompt is too long: 250000 tokens > 200000 maximum",
      "Request too large for the target model"
    ]) {
      expect(isPromptTooLongError({ status: 400, message })).toBe(true);
    }
  });

  test("unrelated 400s stay false", () => {
    expect(isPromptTooLongError({ status: 400, message: "invalid api key" })).toBe(false);
    expect(isPromptTooLongError({ status: 500, message: "context length" })).toBe(false);
  });

  test("Gemini and TGI overflow wordings are recognized (#709 item 3)", () => {
    expect(isPromptTooLongError({
      status: 400,
      message: "The input token count (123456) exceeds the maximum number of tokens allowed (100000)."
    })).toBe(true);
    // TGI router answers ValidationError with HTTP 422 (#725 review S3)
    expect(isPromptTooLongError({
      status: 422,
      message: "Input validation error: `inputs` must have less than 4096 tokens"
    })).toBe(true);
    // OpenAI-compat gateways normalize the same failure to 400
    expect(isPromptTooLongError({
      status: 400,
      message: "Input validation error: `inputs` must have less than 4096 tokens"
    })).toBe(true);
    // Non-overflow 422s stay out of recovery
    expect(isPromptTooLongError({ status: 422, message: "invalid temperature" })).toBe(false);
  });

  test("413 gateway HTML body-limit pages do not enter recovery (#709 item 3)", () => {
    expect(isPromptTooLongError({
      status: 413,
      message: "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n</html>"
    })).toBe(false);
    expect(isPromptTooLongError({
      status: 400,
      message: "<html><body>Bad Request</body></html>"
    })).toBe(false);
  });

  test("structured code still wins over an HTML body (#725 review R4)", () => {
    expect(isPromptTooLongError({
      status: 400,
      error: { error: { code: "context_length_exceeded", message: "<html>gateway page</html>" } }
    })).toBe(true);
  });

  test("nested err.error.error.message form is recognized (#725 review R9)", () => {
    expect(isPromptTooLongError({
      status: 400,
      error: { error: { message: "`inputs` must have less than 4096 tokens" } }
    })).toBe(true);
    expect(isPromptTooLongError({
      status: 413,
      error: { error: { message: "<html><body>413</body></html>" } }
    })).toBe(false);
  });

  test("Gemini and TGI overflow wording variants (#725 review R4 residual)", () => {
    expect(isPromptTooLongError({
      status: 400,
      message: "Unable to submit request because the input token count is 135538 but model only supports up to 131072"
    })).toBe(true);
    expect(isPromptTooLongError({
      status: 422,
      message: "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 1024. Given: 1872"
    })).toBe(true);
  });
});
