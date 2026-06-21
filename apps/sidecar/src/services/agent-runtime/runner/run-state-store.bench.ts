// 手动基准脚本：bun apps/sidecar/src/services/agent-runtime/runner/run-state-store.bench.ts
// 不被 bun test 自动收集；用于量化 appendItem 改造前后的耗时差异。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedLumeRunStateStore } from "./run-state-store";
import type { LumeRunState } from "./run-state";

function makeState(runId: string): LumeRunState {
  const now = new Date("2026-04-29T00:00:00.000Z").toISOString();
  return {
    version: 1, runId, threadId: "thread-1", rootAgentId: "root", currentAgentId: "root",
    status: "running", input: { userMessage: "hi", permissionMode: "default" },
    generatedItems: [], pendingInterruptions: [], approvals: { alwaysAllowedTools: [] },
    traceId: `trace-${runId}`, model: { provider: "openai", modelId: "gpt-test" },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, createdAt: now, updatedAt: now
  };
}

const dir = mkdtempSync(join(tmpdir(), "lume-run-state-bench-"));
const store = createFileBackedLumeRunStateStore(dir);
await store.create(makeState("bench-1"));
const N = 500;
const start = performance.now();
for (let i = 1; i <= N; i++) {
  await store.appendItem("bench-1", { type: "system_event", id: `item-${i}`, name: "n", createdAt: `2026-04-29T00:00:00.000Z` });
}
const elapsed = performance.now() - start;
const stored = await store.get("bench-1");
console.log(`appendItem x${N}: ${elapsed.toFixed(1)}ms, items=${stored?.generatedItems.length}`);
