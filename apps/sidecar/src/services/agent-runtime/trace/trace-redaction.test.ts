import { describe, expect, test } from "bun:test";
import type { LumeTrace } from "./trace-types";
import { redactTraceForLevel, redactTracePayload } from "./trace-redaction";

function createTrace(): LumeTrace {
  return {
    id: "trace-1",
    threadId: "thread-1",
    runId: "run-1",
    name: "test trace",
    status: "completed",
    startedAt: "2026-04-29T00:00:00.000Z",
    spans: [{
      id: "span-1",
      traceId: "trace-1",
      type: "tool_call",
      name: "Bash",
      status: "completed",
      startedAt: "2026-04-29T00:00:00.000Z",
      input: {
        command: "echo OPENAI_API_KEY=sk-secret-token",
        nested: { token: "plain-secret" }
      },
      output: "private_key=-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      metadata: {
        cwd: "/tmp/project",
        apiKey: "sk-metadata-secret"
      }
    }]
  };
}

describe("trace redaction", () => {
  test("safe_summary keeps structure but removes raw payloads and secrets", () => {
    const redacted = redactTraceForLevel(createTrace(), "safe_summary");
    const json = JSON.stringify(redacted);

    expect(json).toContain("tool_call");
    expect(json).not.toContain("OPENAI_API_KEY");
    expect(json).not.toContain("plain-secret");
    expect(json).not.toContain("PRIVATE KEY");
    expect(redacted.spans[0]?.input).toEqual("[REDACTED_PAYLOAD]");
    expect(redacted.spans[0]?.output).toEqual("[REDACTED_PAYLOAD]");
  });

  test("diagnostic redacts secrets while preserving useful payload shape", () => {
    const redacted = redactTraceForLevel(createTrace(), "diagnostic");
    const json = JSON.stringify(redacted);

    expect(redacted.spans[0]?.input).toMatchObject({
      command: "echo OPENAI_API_KEY=[REDACTED]",
      nested: { token: "[REDACTED]" }
    });
    expect(json).toContain("/tmp/project");
    expect(json).not.toContain("sk-secret-token");
    expect(json).not.toContain("plain-secret");
    expect(json).not.toContain("PRIVATE KEY");
  });

  test("raw_internal only clones trace without redacting", () => {
    const raw = redactTraceForLevel(createTrace(), "raw_internal");
    expect(JSON.stringify(raw)).toContain("sk-secret-token");
    expect(raw).not.toBe(createTrace());
  });

  test("redactTracePayload truncates long strings", () => {
    expect(redactTracePayload("x".repeat(2100), "diagnostic")).toBe(`${"x".repeat(2000)}...(truncated)`);
  });
});

