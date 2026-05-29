import { describe, expect, test } from "bun:test";
import {
  createDiagnosticLogSummary,
  getCurrentLogFileName,
  redactDiagnosticLogData,
  shouldWriteLogFile
} from "./logger";

describe("logger diagnostic helpers", () => {
  test("redacts sensitive keys recursively", () => {
    expect(redactDiagnosticLogData({
      token: "secret-token",
      nested: {
        apiKey: "abc",
        value: "visible"
      },
      items: [{
        password: "hidden"
      }]
    })).toEqual({
      token: "[redacted]",
      nested: {
        apiKey: "[redacted]",
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
    expect(summary).toContain("(truncated)");
  });

  test("uses the shared daily log file and can disable sidecar file writes", () => {
    expect(getCurrentLogFileName(new Date("2026-05-29T08:00:00.000Z"))).toBe("lume-2026-05-29.log");
    expect(shouldWriteLogFile(undefined)).toBe(true);
    expect(shouldWriteLogFile("true")).toBe(true);
    expect(shouldWriteLogFile("false")).toBe(false);
    expect(shouldWriteLogFile(" FALSE ")).toBe(false);
  });
});
