import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGuidanceStore } from "../guidance/run-guidance-store";
import { createCanUseToolHandler } from "./attempt";

describe("runtime-core attempt guidance", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-attempt-guidance-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    runGuidanceStore.resetForTest();
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("pending guidance 应在工具调用前消费并拒绝原工具执行", async () => {
    const threadId = "thread-guidance";
    const events: unknown[] = [];
    runGuidanceStore.addQueuedDispatch({
      id: "queued-guidance-1",
      threadId,
      text: "先对照 Alice 的实现",
      createdAt: 123
    });

    const handler = createCanUseToolHandler(
      {
        input: {
          threadId,
          userMessage: "当前任务"
        },
        runtime: {
          sessionId: threadId
        }
      } as never,
      {
        workspaceSlug: undefined,
        agentCwd: "/tmp"
      } as never,
      {
        onRuntimeEvent: (event: unknown) => {
          events.push(event);
        }
      } as never,
      new AbortController().signal,
      "run-guidance"
    );

    const result = await handler(
      { name: "Bash" } as never,
      { command: "echo should-not-run" },
      { toolUseId: "tool-1" }
    );

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("用户在工具执行前追加了引导");
    expect(result.message).toContain("1. 先对照 Alice 的实现");
    expect(result.message).toContain("原工具调用尚未执行");
    expect(runGuidanceStore.listPending(threadId)).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "guidance.delivered",
      threadId,
      runId: "run-guidance",
      guidanceIds: ["queued-guidance-1"],
      text: "1. 先对照 Alice 的实现"
    }));
  });

  test("富 guidance 的附件摘要应出现在 tool denial 文本中", async () => {
    const threadId = "thread-rich-guidance";
    runGuidanceStore.addQueuedDispatch({
      id: "queued-rich-1",
      threadId,
      text: "参考这张注释",
      createdAt: 200,
      attachmentsBrief: "<browser_attachments>注释: 按钮颜色改为红色</browser_attachments>"
    });

    const handler = createCanUseToolHandler(
      { input: { threadId, userMessage: "任务" }, runtime: { sessionId: threadId } } as never,
      { workspaceSlug: undefined, agentCwd: "/tmp" } as never,
      { onRuntimeEvent: () => undefined } as never,
      new AbortController().signal,
      "run-rich",
    );

    const result = await handler({ name: "Bash" } as never, { command: "echo" }, { toolUseId: "tool-rich" });
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("参考这张注释");
    expect(result.message).toContain("按钮颜色改为红色");
  });
});
