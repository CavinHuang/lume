import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeTraceStore } from "./trace-store";
import { TraceRecorder } from "./trace-recorder";

describe("trace-store", () => {
  test("records trace spans and final status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-trace-store-"));
    const store = createFileBackedLumeTraceStore(dir);
    const recorder = new TraceRecorder(store, {
      createId: (() => {
        const ids = ["trace-1", "span-1", "span-2"];
        return () => ids.shift() ?? "fallback";
      })(),
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 3, 29, 0, 0, tick++)).toISOString();
      })()
    });

    const trace = await recorder.startTrace({
      runId: "run-1",
      threadId: "thread-1",
      name: "Agent run"
    });
    const span = await recorder.startSpan({
      traceId: trace.id,
      type: "model_call",
      name: "call model",
      input: { prompt: "hello" }
    });

    await recorder.endSpan(span.id, { ok: true });
    await recorder.endTrace(trace.id, "completed");

    const stored = await store.get(trace.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.spans).toHaveLength(1);
    expect(stored?.spans[0]).toMatchObject({
      id: "span-1",
      type: "model_call",
      status: "completed",
      output: { ok: true }
    });
    expect(stored?.spans[0]?.durationMs).toBeGreaterThanOrEqual(1000);
  });
});
