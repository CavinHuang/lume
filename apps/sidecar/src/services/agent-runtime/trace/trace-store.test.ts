import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeTraceStore } from "./trace-store";
import { TraceRecorder } from "./trace-recorder";

describe("trace-store", () => {
  test("keeps internal store trace ids separate from correlation trace ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-trace-correlation-"));
    const store = createFileBackedLumeTraceStore(dir);
    const recorder = new TraceRecorder(store, { createId: () => "internal-trace-id" });

    const trace = await recorder.startTrace({
      runId: "run-1",
      threadId: "thread-1",
      name: "Agent run",
      correlationTraceId: "correlation-trace-id",
      parentCorrelationTraceId: "parent-correlation-id"
    });

    expect(trace.id).toBe("internal-trace-id");
    expect(trace.correlationTraceId).toBe("correlation-trace-id");
    expect((await store.get("internal-trace-id"))?.parentCorrelationTraceId).toBe("parent-correlation-id");
    expect(await store.get("correlation-trace-id")).toBeNull();
  });

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

  test("多次 updateSpan 后 get 返回该 span 的最后版本（dedup）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-trace-store-"));
    const store = createFileBackedLumeTraceStore(dir);
    await store.create({ id: "t-dedup", threadId: "th", runId: "r", name: "n", status: "running", startedAt: "2026-04-29T00:00:00.000Z", spans: [] });
    await store.appendSpan("t-dedup", { id: "s1", traceId: "t-dedup", type: "tool_call", name: "x", status: "running", startedAt: "2026-04-29T00:00:00.000Z" });
    await store.updateSpan("t-dedup", "s1", { status: "completed", endedAt: "2026-04-29T00:00:01.000Z", durationMs: 1000 });
    await store.updateSpan("t-dedup", "s1", { status: "failed", error: { message: "boom" } });
    const stored = await store.get("t-dedup");
    expect(stored?.spans).toHaveLength(1);
    expect(stored?.spans[0]).toMatchObject({ id: "s1", status: "failed", durationMs: 1000 });
    expect((stored?.spans[0] as any).error?.message).toBe("boom");
  });

  test("多个 span 保持 startSpan 顺序，updateSpan 不改变顺序", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-trace-store-"));
    const store = createFileBackedLumeTraceStore(dir);
    await store.create({ id: "t-order", threadId: "th", runId: "r", name: "n", status: "running", startedAt: "2026-04-29T00:00:00.000Z", spans: [] });
    await store.appendSpan("t-order", { id: "s1", traceId: "t-order", type: "model_call", name: "a", status: "running", startedAt: "2026-04-29T00:00:00.000Z" });
    await store.appendSpan("t-order", { id: "s2", traceId: "t-order", type: "tool_call", name: "b", status: "running", startedAt: "2026-04-29T00:00:01.000Z" });
    await store.updateSpan("t-order", "s2", { status: "completed", endedAt: "2026-04-29T00:00:02.000Z" });
    await store.updateSpan("t-order", "s1", { status: "completed", endedAt: "2026-04-29T00:00:03.000Z" });
    const stored = await store.get("t-order");
    expect(stored?.spans.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(stored?.spans.every((s) => s.status === "completed")).toBe(true);
  });

  test("update 元数据不改动 spans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-trace-store-"));
    const store = createFileBackedLumeTraceStore(dir);
    await store.create({ id: "t-meta", threadId: "th", runId: "r", name: "n", status: "running", startedAt: "2026-04-29T00:00:00.000Z", spans: [] });
    await store.appendSpan("t-meta", { id: "s1", traceId: "t-meta", type: "model_call", name: "a", status: "running", startedAt: "2026-04-29T00:00:00.000Z" });
    await store.update("t-meta", { status: "completed", endedAt: "2026-04-29T00:00:05.000Z" });
    const stored = await store.get("t-meta");
    expect(stored?.status).toBe("completed");
    expect(stored?.spans).toHaveLength(1);
    expect(stored?.spans[0]?.id).toBe("s1");
  });
});
