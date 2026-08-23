import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerRealAgentThreadStore } from "../agent-thread-store-test-adapter";

registerRealAgentThreadStore();

describe("createAutoTitleJob", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-auto-title-job-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
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

  test("应在默认线程标题上生成 fallback 标题并通知订阅者", async () => {
    const { createAgentThread, getAgentThreadMeta } = await import("../../agent/agent-thread-manager");
    const { createAutoTitleJob } = await import("./auto-title-job");
    const thread = createAgentThread("新 Agent 线程", "channel-test");
    const updatedTitles: string[] = [];
    const job = createAutoTitleJob({
      threadId: thread.id,
      fallbackUserMessage: "实现 Service Runtime",
      onTitleUpdated: (title) => {
        updatedTitles.push(title);
      }
    });

    expect(job).toEqual(expect.objectContaining({
      id: `title.generate:${thread.id}`,
      type: "title.generate"
    }));
    if (!job) {
      throw new Error("auto title job was not created");
    }

    await job.run();

    expect(getAgentThreadMeta(thread.id)?.title).toBe("实现 Service Runtime");
    expect(updatedTitles).toEqual(["实现 Service Runtime"]);
  });

  test("配置标题生成器时优先使用生成标题", async () => {
    const { createAgentThread, getAgentThreadMeta } = await import("../../agent/agent-thread-manager");
    const { createAutoTitleJob } = await import("./auto-title-job");
    const thread = createAgentThread("新 Agent 线程", "channel-test");
    const job = createAutoTitleJob({
      threadId: thread.id,
      fallbackUserMessage: "实现 Service Runtime",
      generateTitle: async () => "后台模型设置",
    });

    if (!job) {
      throw new Error("auto title job was not created");
    }

    await job.run();

    expect(getAgentThreadMeta(thread.id)?.title).toBe("后台模型设置");
  });

  test("非默认标题不应生成 job", async () => {
    const { createAgentThread } = await import("../../agent/agent-thread-manager");
    const { createAutoTitleJob } = await import("./auto-title-job");
    const thread = createAgentThread("已有标题", "channel-test");

    expect(createAutoTitleJob({
      threadId: thread.id,
      fallbackUserMessage: "这条消息不会改标题",
      onTitleUpdated: () => undefined
    })).toBeNull();
  });
});
