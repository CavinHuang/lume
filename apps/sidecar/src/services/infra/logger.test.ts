import { describe, expect, test } from "bun:test";
import * as loggerModule from "./logger";
import {
  createDiagnosticLogSummary,
  acknowledgeLogBatch,
  flushLogTransport,
  getCurrentLogFileName,
  redactDiagnosticLogData,
  sanitizeBaseUrlForLog,
  setLogBatchNotificationWriter,
  writeLogRecord
} from "./logger";

describe("logger diagnostic helpers", () => {
  test("redacts sensitive keys recursively", () => {
    expect(redactDiagnosticLogData({
      token: "secret-token",
      nested: {
        apiKey: "abc",
        referenceGrantId: "grant-capability",
        value: "visible"
      },
      items: [{
        password: "hidden"
      }]
    })).toEqual({
      token: "[redacted]",
      nested: {
        apiKey: "[redacted]",
        referenceGrantId: "[redacted]",
        value: "visible"
      },
      items: [{
        password: "[redacted]"
      }]
    });
  });

  test("summarizes large payloads without leaking secrets", () => {
    const summary = createDiagnosticLogSummary({
      token: "secret-token",
      text: "x".repeat(300)
    }, 120);

    expect(summary).not.toContain("secret-token");
    expect(summary).toContain("[redacted]");
    expect(summary.length).toBeLessThanOrEqual(135);
    expect(summary).toContain("…[truncated]");
  });

  test("uses the shared daily log file name while main owns persistence", () => {
    expect(getCurrentLogFileName(new Date("2026-05-29T08:00:00.000Z"))).toBe("lume-2026-05-29.ndjson");
    expect(loggerModule.shouldWriteLogFile()).toBe(false);
  });

  test("keeps the full base URL path while removing credentials, query, fragment, and token-like segments", () => {
    expect(sanitizeBaseUrlForLog("https://user:pass@example.com/v1/accounts/token/abc123456789012345678901?api_key=secret#x"))
      .toBe("https://example.com/v1/accounts/token/[redacted]");
    expect(sanitizeBaseUrlForLog("https://example.com/openai/deployments/gpt-4/chat/completions"))
      .toBe("https://example.com/openai/deployments/gpt-4/chat/completions");
  });

  test("emits structured sidecar batches to the Electron host writer", () => {
    const batches: any[] = [];

    setLogBatchNotificationWriter((batch) => {
      batches.push(batch);
    });
    try {
      writeLogRecord({
        level: "info",
        context: "console",
        message: "booting",
        data: { apiKey: "secret", ok: true }
      });
      flushLogTransport();
      acknowledgeLogBatch(batches[0].batchId);
    } finally {
      setLogBatchNotificationWriter(null);
    }

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      schemaVersion: 2,
      source: "sidecar",
      events: [{
        level: "info",
        source: "sidecar",
        context: "console",
        message: "booting",
        data: { apiKey: "[redacted]", ok: true }
      }]
    });
    expect(batches[0].events[0].emittedAt).toEqual(expect.any(String));
  });
});
