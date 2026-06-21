// 手动基准脚本：bun apps/sidecar/src/services/agent-runtime/trace/trace-store.bench.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeTraceStore } from "./trace-store";

const dir = mkdtempSync(join(tmpdir(), "lume-trace-bench-"));
const store = createFileBackedLumeTraceStore(dir);
const traceId = "bench-trace";
await store.create({ id: traceId, threadId: "th", runId: "r", name: "n", status: "running", startedAt: "2026-04-29T00:00:00.000Z", spans: [] });

const N = 500;
const start1 = performance.now();
for (let i = 1; i <= N; i++) {
  await store.appendSpan(traceId, { id: `s${i}`, traceId, type: "tool_call", name: `n${i}`, status: "running", startedAt: "2026-04-29T00:00:00.000Z" });
}
const appendMs = performance.now() - start1;

const start2 = performance.now();
for (let i = 1; i <= N; i++) {
  await store.updateSpan(traceId, `s${i}`, { status: "completed", endedAt: "2026-04-29T00:00:01.000Z", durationMs: 1 });
}
const updateMs = performance.now() - start2;

const stored = await store.get(traceId);
console.log(`appendSpan x${N}: ${appendMs.toFixed(1)}ms`);
console.log(`updateSpan x${N}: ${updateMs.toFixed(1)}ms`);
console.log(`final spans=${stored?.spans.length}`);
