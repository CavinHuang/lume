import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LumeRuntimeEvent } from "@lume/shared";
import {
  getAgentRuntimeStatusManager,
  resetAgentRuntimeStatusManagerForTest
} from "../agent/agent-runtime-status-manager";
import type { FeishuCardStreamOptions } from "./feishu/feishu-card-stream";
import { createImAccount } from "./im-config-manager";
import { upsertImThreadBinding } from "./im-thread-binding-store";
import {
  createImRunCardSession,
  setImRunCardStreamFactoryForTest
} from "./im-run-card-session";

describe("im-run-card-session 压缩中间态订阅链路（#725 review S1/S3）", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";
  let appliedEvents: LumeRuntimeEvent[] = [];
  let openOk = true;

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-im-card-sub-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    appliedEvents = [];
    openOk = true;
    resetAgentRuntimeStatusManagerForTest();
  });

  afterEach(() => {
    setImRunCardStreamFactoryForTest(null);
    resetAgentRuntimeStatusManagerForTest();
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  async function bindFeishuThread(threadId: string): Promise<void> {
    const account = await createImAccount({
      provider: "feishu",
      label: "飞书订阅测试",
      accountKey: "cli_sub",
      token: "secret",
      enabled: true
    });
    upsertImThreadBinding({
      provider: "feishu",
      accountId: account.id,
      peerKind: "dm",
      peerId: "oc_sub",
      threadId
    });
  }

  /** 拦截网络边界的假卡片流：走真实 internal 路径，仅替换 FeishuCardStream */
  function installFakeStream(): void {
    setImRunCardStreamFactoryForTest((_options: FeishuCardStreamOptions) => ({
      open: async () => openOk,
      apply: (event: LumeRuntimeEvent) => {
        appliedEvents.push(event);
      },
      get state() {
        return { status: "running" as const, blocks: [], startedAtMs: 0 };
      },
      get degraded() {
        return false;
      },
      close: () => {}
    }));
  }

  async function openSession(threadId: string): Promise<NonNullable<ReturnType<typeof createImRunCardSession>>> {
    const session = createImRunCardSession(threadId)!;
    // 建卡由首个内容类事件触发（OPEN_TRIGGER_EVENTS），喂一个 tool.started
    session.handleEvent({
      id: "e-open",
      type: "tool.started",
      threadId,
      runId: "",
      createdAt: new Date().toISOString(),
      toolCallId: "tc-open",
      toolName: "Bash"
    } as LumeRuntimeEvent);
    await session.settleOpen();
    return session;
  }

  test("compacting phase 置位/离开驱动合成事件进卡片流", async () => {
    await bindFeishuThread("thread-sub-1");
    installFakeStream();
    const statuses = getAgentRuntimeStatusManager();
    const session = await openSession("thread-sub-1");

    statuses.markStreaming("thread-sub-1");
    statuses.markCompacting("thread-sub-1");
    statuses.markStreaming("thread-sub-1");

    // 首个 tool.started 是建卡触发事件，一并进流
    const compactionTypes = appliedEvents
      .map((event) => event.type)
      .filter((type) => type.startsWith("context.compaction"));
    expect(compactionTypes).toEqual([
      "context.compaction.started",
      "context.compaction.completed"
    ]);
    session.finish({ kind: "completed" });
  });

  test("finish 后退订：迟到的 phase 变化不再进卡片流", async () => {
    await bindFeishuThread("thread-sub-2");
    installFakeStream();
    const statuses = getAgentRuntimeStatusManager();
    const session = await openSession("thread-sub-2");

    session.finish({ kind: "completed" });
    const countBefore = appliedEvents.length;
    statuses.markCompacting("thread-sub-2");
    expect(appliedEvents.length).toBe(countBefore);
  });

  test("非本线程的 phase 广播不串扰", async () => {
    await bindFeishuThread("thread-sub-3");
    installFakeStream();
    const statuses = getAgentRuntimeStatusManager();
    const session = await openSession("thread-sub-3");

    statuses.markCompacting("thread-other");
    expect(appliedEvents.filter((event) => event.type.startsWith("context.compaction"))).toHaveLength(0);
    session.finish({ kind: "completed" });
  });

  test("开卡前已置位的压缩态在对齐块补发 started", async () => {
    await bindFeishuThread("thread-sub-4");
    installFakeStream();
    const statuses = getAgentRuntimeStatusManager();
    statuses.markCompacting("thread-sub-4");

    const session = await openSession("thread-sub-4");
    const compactionTypes = appliedEvents
      .map((event) => event.type)
      .filter((type) => type.startsWith("context.compaction"));
    expect(compactionTypes).toEqual(["context.compaction.started"]);
    session.finish({ kind: "completed" });
  });

  test("开卡失败退订：phase 变化不再进已关闭的流", async () => {
    await bindFeishuThread("thread-sub-5");
    installFakeStream();
    openOk = false;
    const statuses = getAgentRuntimeStatusManager();
    const session = createImRunCardSession("thread-sub-5")!;
    session.handleEvent({
      id: "e-open-fail",
      type: "tool.started",
      threadId: "thread-sub-5",
      runId: "",
      createdAt: new Date().toISOString(),
      toolCallId: "tc-fail",
      toolName: "Bash"
    } as LumeRuntimeEvent);
    expect(await session.settleOpen()).toBeFalse();

    statuses.markCompacting("thread-sub-5");
    expect(appliedEvents.filter((event) => event.type.startsWith("context.compaction"))).toHaveLength(0);
  });
});
