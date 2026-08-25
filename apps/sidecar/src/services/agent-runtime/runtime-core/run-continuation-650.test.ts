import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedRunContinuationStore } from "./run-continuation-store";

// #650：多后台任务的续跑快照不再单槽互覆——主槽保留最新任务，旧任务降级进
// backgroundCheckpoints 数组，终态回填按 processJobId 命中对应槽位。
describe("background checkpoint 多槽(#650)", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("第二个任务入队时首个任务降级进 backgroundCheckpoints", async () => {
    dir = mkdtempSync(join(tmpdir(), "lume-650-"));
    const store = createFileBackedRunContinuationStore(dir);
    const mk = (jobId: string, toolCallId: string) => ({
      version: 2 as const,
      runId: "run-650",
      threadId: "thread-650",
      status: "waiting_background" as const,
      checkpoint: {
        step: "waiting_for_tool_result" as const,
        toolCallId,
        toolName: "Bash",
        toolKind: "execute" as const,
        processJobId: jobId,
        toolCall: {
          id: toolCallId,
          name: "Bash",
          input: {},
          inputHash: `hash-${jobId}`,
          kind: "execute" as const,
        },
      },
      reason: "test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await store.upsert(mk("job-A", "call-A"));
    await store.upsert({ ...mk("job-B", "call-B"), updatedAt: new Date().toISOString() });

    const state = await store.get("run-650");
    expect(state?.checkpoint.processJobId).toBe("job-B");
    expect(state?.backgroundCheckpoints).toHaveLength(1);
    expect(state?.backgroundCheckpoints?.[0]?.processJobId).toBe("job-A");
  });

  test("次槽终态回填命中 backgroundCheckpoints 数组项", async () => {
    dir = mkdtempSync(join(tmpdir(), "lume-650-fill-"));
    const store = createFileBackedRunContinuationStore(dir);
    await store.upsert({
      version: 2,
      runId: "run-650b",
      threadId: "thread-650b",
      status: "waiting_background",
      checkpoint: {
        step: "waiting_for_tool_result",
        toolCallId: "call-main",
        toolName: "Bash",
        toolKind: "execute",
        processJobId: "job-main",
        toolCall: { id: "call-main", name: "Bash", input: {}, inputHash: "h", kind: "execute" },
      },
      backgroundCheckpoints: [{
        processJobId: "job-side",
        toolCallId: "call-side",
        toolName: "Bash",
        toolKind: "execute",
        toolCall: { id: "call-side", name: "Bash", input: {}, inputHash: "hs", kind: "execute" },
        updatedAt: new Date().toISOString(),
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 模拟 handleAsyncEvent 对 job-side 的终态回填
    const current = await store.get("run-650b");
    const others = current!.backgroundCheckpoints ?? [];
    const hit = others.findIndex((item) => item.processJobId === "job-side");
    expect(hit).toBeGreaterThanOrEqual(0);
    await store.update("run-650b", {
      backgroundCheckpoints: others.map((item, index) =>
        index === hit ? { ...item, syntheticToolResult: { type: "tool_result", tool_use_id: item.toolCallId, content: "done" } } : item),
    });

    const after = await store.get("run-650b");
    expect(after?.backgroundCheckpoints?.[0]?.syntheticToolResult).toMatchObject({ content: "done" });
  });
});
