import { describe, expect, test } from "bun:test";
import * as loggerModule from "./logger";
import {
  createDiagnosticLogSummary,
  acknowledgeLogBatch,
  flushLogTransport,
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

  test("handles a synchronous acknowledgement without corrupting in-flight state", () => {
    const batches: any[] = [];
    setLogBatchNotificationWriter((batch) => {
      batches.push(batch);
      acknowledgeLogBatch(batch.batchId);
    });
    try {
      writeLogRecord({ level: "info", context: "console", message: "sync ack" });
      flushLogTransport();
    } finally {
      setLogBatchNotificationWriter(null);
    }
    expect(batches).toHaveLength(1);
  });
});

describe("log transport writer lifecycle（#829 跨文件污染根修）", () => {
  test("摘除 writer 清空积压与在途：下一任 writer 只收此后事件（#829）", () => {
    const residue: Array<{ context?: string }> = [];
    setLogBatchNotificationWriter((batch) => {
      residue.push(...batch.events);
      // 故意不 ack：制造带计时器的在途批次（污染源形态）
    });
    writeLogRecord({ level: "info", context: "t.residue", message: "prev-owner" });
    flushLogTransport();
    // 摘除即清：积压与在途计时器一并解除
    setLogBatchNotificationWriter(null);
    const seen: Array<{ context?: string }> = [];
    setLogBatchNotificationWriter((batch) => {
      seen.push(...batch.events);
      acknowledgeLogBatch(batch.batchId);
    });
    expect(seen.some((event) => event.context === "t.residue")).toBeFalse();
    writeLogRecord({ level: "info", context: "t.fresh", message: "new-world" });
    flushLogTransport();
    expect(seen.some((event) => event.context === "t.fresh")).toBeTrue();
    setLogBatchNotificationWriter(null);
  });
});
