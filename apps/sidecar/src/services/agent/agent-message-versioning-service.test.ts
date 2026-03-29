import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentMessage } from "@lume/shared";
import {
  createAssistantMessageVersion,
  createUserMessageVersion,
  getAgentMessageVersions,
  getVisibleAgentMessages,
  initializeVersionStoreFromMessages,
  syncVersionStoreFromMessages
} from "./agent-message-versioning-service";

describe("agent-message-versioning-service", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-versioning-"));
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

  test("initializeVersionStoreFromMessages 应将 transcript 初始化为单版本消息组", () => {
    const transcriptMessages: AgentMessage[] = [
      {
        id: "runtime-1",
        role: "user",
        content: "第一条",
        createdAt: 1
      },
      {
        id: "runtime-2",
        role: "assistant",
        content: "第二条",
        createdAt: 2,
        model: "provider/model"
      }
    ];

    initializeVersionStoreFromMessages("session-a", transcriptMessages);
    const visible = getVisibleAgentMessages("session-a");

    expect(visible.length).toBe(2);
    expect(visible[0]?.versionIndex).toBe(1);
    expect(visible[0]?.versionCount).toBe(1);
    expect(visible[0]?.isLatestVersion).toBeTrue();
    expect(visible[1]?.versionIndex).toBe(1);
    expect(visible[1]?.versionCount).toBe(1);
    expect(visible[1]?.model).toBe("provider/model");
  });

  test("getAgentMessageVersions 应返回同组全部版本", () => {
    const transcriptMessages: AgentMessage[] = [
      {
        id: "runtime-1",
        role: "user",
        content: "第一条",
        createdAt: 1
      }
    ];

    initializeVersionStoreFromMessages("session-b", transcriptMessages);
    const visible = getVisibleAgentMessages("session-b");
    const groupId = visible[0]?.versionGroupId ?? "";
    const versions = getAgentMessageVersions("session-b", groupId);

    expect(versions.length).toBe(1);
    expect(versions[0]?.content).toBe("第一条");
    expect(versions[0]?.versionCount).toBe(1);
  });

  test("syncVersionStoreFromMessages 在 transcript 未变化时应保持稳定 message id", () => {
    const transcriptMessages: AgentMessage[] = [
      {
        id: "runtime-1",
        role: "user",
        content: "第一条",
        createdAt: 1
      }
    ];

    syncVersionStoreFromMessages("session-c", transcriptMessages);
    const firstVisible = getVisibleAgentMessages("session-c");
    syncVersionStoreFromMessages("session-c", transcriptMessages);
    const secondVisible = getVisibleAgentMessages("session-c");

    expect(firstVisible[0]?.id).toBe(secondVisible[0]?.id);
  });

  test("createUserMessageVersion 应为重发生成新版本并裁剪可见链", () => {
    initializeVersionStoreFromMessages("session-d", [
      { id: "runtime-1", role: "user", content: "问题1", createdAt: 1 },
      { id: "runtime-2", role: "assistant", content: "回答1", createdAt: 2 },
      { id: "runtime-3", role: "user", content: "问题2", createdAt: 3 },
      { id: "runtime-4", role: "assistant", content: "回答2", createdAt: 4 }
    ]);

    const before = getVisibleAgentMessages("session-d");
    const result = createUserMessageVersion({
      sessionId: "session-d",
      sourceMessageId: before[0]!.id,
      content: "问题1 重发",
      createdAt: 10
    });
    const visible = getVisibleAgentMessages("session-d");
    const versions = getAgentMessageVersions("session-d", result.message.versionGroupId ?? "");

    expect(result.message.versionIndex).toBe(2);
    expect(visible.length).toBe(1);
    expect(visible[0]?.content).toBe("问题1 重发");
    expect(versions.length).toBe(2);
    expect(versions[0]?.content).toBe("问题1");
    expect(versions[1]?.content).toBe("问题1 重发");
  });

  test("createAssistantMessageVersion 应在同 turn 下追加 assistant 最新版本", () => {
    initializeVersionStoreFromMessages("session-e", [
      { id: "runtime-1", role: "user", content: "问题1", createdAt: 1 }
    ]);

    const userResult = createUserMessageVersion({
      sessionId: "session-e",
      content: "问题2",
      createdAt: 2
    });
    const assistant = createAssistantMessageVersion({
      sessionId: "session-e",
      turnId: userResult.turnId,
      message: {
        id: "runtime-a",
        role: "assistant",
        content: "回答2",
        createdAt: 3,
        model: "provider/model"
      }
    });
    const visible = getVisibleAgentMessages("session-e");
    const versions = getAgentMessageVersions("session-e", assistant?.versionGroupId ?? "");

    expect(assistant?.versionIndex).toBe(1);
    expect(visible.map((message) => message.content)).toEqual(["问题1", "问题2", "回答2"]);
    expect(versions.length).toBe(1);
    expect(versions[0]?.content).toBe("回答2");
  });

  test("syncVersionStoreFromMessages 在已有历史版本时不应重置版本链", () => {
    initializeVersionStoreFromMessages("session-f", [
      { id: "runtime-1", role: "user", content: "问题1", createdAt: 1 }
    ]);

    const resent = createUserMessageVersion({
      sessionId: "session-f",
      sourceMessageId: getVisibleAgentMessages("session-f")[0]!.id,
      content: "问题1 重发",
      createdAt: 2
    });

    syncVersionStoreFromMessages("session-f", [
      { id: "runtime-new", role: "user", content: "来自 transcript 的单条消息", createdAt: 99 }
    ]);

    const visible = getVisibleAgentMessages("session-f");
    const versions = getAgentMessageVersions("session-f", resent.message.versionGroupId ?? "");

    expect(visible.length).toBe(1);
    expect(visible[0]?.content).toBe("问题1 重发");
    expect(versions.length).toBe(2);
  });

  test("syncVersionStoreFromMessages 在单版本对齐时应保留已有 metadata", () => {
    initializeVersionStoreFromMessages("session-g", [
      {
        id: "runtime-1",
        role: "user",
        content: "你是谁？",
        createdAt: 1,
        metadata: { pendingClientMessageId: "pending-1" }
      }
    ]);

    syncVersionStoreFromMessages("session-g", [
      {
        id: "runtime-2",
        role: "user",
        content: "你是谁？",
        createdAt: 99
      }
    ]);

    const visible = getVisibleAgentMessages("session-g");

    expect((visible[0]?.metadata as Record<string, unknown> | undefined)?.pendingClientMessageId).toBe("pending-1");
  });
});
