/**
 * 回归：consolidation 完成时除 memory.job.completed 外，必须补发 live memory.changed
 * 运行时事件（id 用与落盘 memory_saved 消息相同的 uuid 段），否则刷新后 replay
 * 投影出同内容异 id 的消息 → 幽灵消息突现。
 *
 * 本文件用 mock.module 隔离重依赖（dream-organizer/derived-views），捕获
 * emitAgentNotification 通知；runner 会将含 mock.module 的文件单独进程执行。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AGENT_IPC_CHANNELS, type LumeRuntimeEvent } from "@lume/shared";

interface CapturedNotification {
  channel: string;
  payload: unknown;
}

const captured: CapturedNotification[] = [];

mock.module("../agent/agent-notification-service", () => ({
  emitAgentNotification: (channel: string, payload: unknown) => {
    captured.push({ channel, payload });
  }
}));

mock.module("./dream-organizer", () => ({
  runDreamOrganizer: async () => ({
    sessionsReviewed: 1,
    evidenceItemsReviewed: 2,
    scannedEntries: 3,
    actions: { created: 2, versioned: 0, updated: 0, merged: 0, stale: 0, pending: 0, ignored: 0 },
    items: [],
    warnings: []
  })
}));

mock.module("./derived-views", () => ({
  rebuildDerivedMemoryViews: async () => []
}));

const { enqueueConsolidation } = await import("./consolidation");
const { memoryJobService } = await import("./job-service");
const { getAgentThreadSDKMessages } = await import("../agent/agent-thread-manager");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-consolidation-live-"));
  process.env.LUME_CONFIG_DIR = root;
  captured.length = 0;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("consolidation live memory.changed", () => {
  test("完成路径补发 memory.changed（与 job.completed 并存，id 对齐落盘消息 uuid）", async () => {
    const threadId = "thread-consolidation-live";
    const runId = "run-consolidation-live-1";
    const job = enqueueConsolidation("demo", true, { threadId, runId });
    expect(job?.kind).toBe("consolidation");
    await memoryJobService.waitForSettled();

    const runtimeEvents = captured
      .filter((entry) => entry.channel === AGENT_IPC_CHANNELS.RUNTIME_EVENT)
      .map((entry) => (entry.payload as { event: LumeRuntimeEvent }).event);

    const saved = getAgentThreadSDKMessages(threadId)
      .find((message) => message.type === "system" && message.subtype === "memory_saved");
    expect(saved?.uuid).toBeTruthy();

    const changed = runtimeEvents.filter(
      (event): event is Extract<LumeRuntimeEvent, { type: "memory.changed" }> => event.type === "memory.changed"
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      id: `${runId}:memory.changed:${saved?.uuid}`,
      type: "memory.changed",
      actor: "consolidation",
      workspaceSlug: "demo",
      mutationIds: [],
      memoryIds: [],
      summary: expect.stringContaining("整理了 2 条记忆")
    });

    const jobCompleted = runtimeEvents.find(
      (event): event is Extract<LumeRuntimeEvent, { type: "memory.job.completed" }> => event.type === "memory.job.completed"
    );
    expect(jobCompleted).toMatchObject({ jobId: job?.jobId, status: "completed" });
    expect(jobCompleted?.summary).toBe(changed[0]!.summary);
  });
});
