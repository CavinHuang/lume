import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SDKMessage } from "@lume/shared";

const flushCalls: unknown[] = [];

mock.module("../../memory/memory-flush-runner", () => ({
  runStructuredMemoryFlush: async (params: unknown) => {
    flushCalls.push(params);
    return {
      savedCount: 1,
      skippedCount: 0
    };
  }
}));

describe("createCompactionMemoryFlushJob", () => {
  beforeEach(() => {
    flushCalls.length = 0;
  });

  test("应把 compact boundary summary 转为结构化 memory flush job", async () => {
    const { createCompactionMemoryFlushJob } = await import("./compaction-memory-flush-job");
    const job = createCompactionMemoryFlushJob({
      workspaceSlug: "workspace-a",
      threadId: "thread-a",
      message: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          summary: "Compaction captured the architecture boundary decision."
        }
      } as SDKMessage
    });

    expect(job).toEqual(expect.objectContaining({
      id: "memory.flush:thread-a:compact_boundary",
      type: "memory.flush"
    }));

    await job?.run();

    expect(flushCalls).toHaveLength(1);
    expect(flushCalls[0]).toEqual(expect.objectContaining({
      workspaceSlug: "workspace-a",
      sessionId: "thread-a"
    }));
    expect((flushCalls[0] as { rawOutput?: string }).rawOutput).toContain("Compaction captured the architecture boundary decision.");
  });

  test("没有 workspace 或 summary 时不创建 job", async () => {
    const { createCompactionMemoryFlushJob } = await import("./compaction-memory-flush-job");

    expect(createCompactionMemoryFlushJob({
      workspaceSlug: undefined,
      threadId: "thread-a",
      message: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          summary: "summary"
        }
      } as SDKMessage
    })).toBeNull();

    expect(createCompactionMemoryFlushJob({
      workspaceSlug: "workspace-a",
      threadId: "thread-a",
      message: {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {}
      } as SDKMessage
    })).toBeNull();
  });
});
