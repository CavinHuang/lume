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

  test("assistant file reference bindings survive version persistence and projection", () => {
    initializeVersionStoreFromMessages("session-file-binding", []);
    const user = createUserMessageVersion({ sessionId: "session-file-binding", content: "问题", createdAt: 1 });
    const fileReferenceBinding = {
      workspaceSlug: "demo",
      projectRootFingerprint: "c".repeat(64),
      fileContextId: "context-1",
    };
    const assistant = createAssistantMessageVersion({
      sessionId: "session-file-binding",
      turnId: user.turnId,
      message: {
        id: "assistant-file-binding",
        role: "assistant",
        content: "`@project/src/app.ts`",
        createdAt: 2,
        fileReferenceBinding,
        fileReferenceProtocolVersion: 1,
      },
    });

    expect(assistant?.fileReferenceBinding).toEqual(fileReferenceBinding);
    expect(getVisibleAgentMessages("session-file-binding").at(-1)?.fileReferenceBinding).toEqual(fileReferenceBinding);
    expect(getAgentMessageVersions("session-file-binding", assistant?.versionGroupId ?? "")[0]?.fileReferenceBinding).toEqual(fileReferenceBinding);
    expect(getAgentMessageVersions("session-file-binding", assistant?.versionGroupId ?? "")[0]?.fileReferenceProtocolVersion).toBe(1);
  });

  test("createUserMessageVersion 应保留用户原始 sdkMessages", () => {
    initializeVersionStoreFromMessages("session-sdk-user", []);

    const created = createUserMessageVersion({
      sessionId: "session-sdk-user",
      content: "用户问题",
      createdAt: 1,
      sdkMessages: [{
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: "用户问题"
          }]
        }
      }]
    });

    const visible = getVisibleAgentMessages("session-sdk-user");
    expect(created.message.sdkMessages).toHaveLength(1);
    expect(created.message.sdkMessages?.[0]?.type).toBe("user");
    // #527 去重:内存出参保留,落盘读出(visible 走 readAgentMessageVersionStore)被裁
    expect(visible[0]?.sdkMessages).toBeUndefined();
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

  // #527 遗留(sdkMessages 双留存去重):全局 sdkMessages.jsonl 是原始流唯一正典,
  // 版本 store 落盘时裁剪至 compaction 子集——内存对象不变,重读只余 compaction
  describe("版本记录 sdkMessages 持久化裁剪(#527 遗留)", () => {
    test("createAssistantMessageVersion 只持久化 compaction 子集", () => {
      initializeVersionStoreFromMessages("session-sdk-trim", []);
      const user = createUserMessageVersion({ sessionId: "session-sdk-trim", content: "问题", createdAt: 1 });
      const assistant = createAssistantMessageVersion({
        sessionId: "session-sdk-trim",
        turnId: user.turnId,
        message: {
          id: "assistant-sdk-trim",
          role: "assistant",
          content: "回答",
          createdAt: 2,
          model: "provider/model",
          sdkMessages: [
            { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "raw" }] } },
            { type: "user", message: { role: "user", content: "tool_result" } },
            { type: "system", subtype: "compact_boundary" },
            { type: "system", subtype: "unrelated_system" }
          ] as never
        }
      });

      // 内存返回不变(内部链路语义)
      expect(assistant?.sdkMessages).toHaveLength(4);
      // 落盘重读被裁(getAgentMessageVersions 走 readAgentMessageVersionStore)
      const versions = getAgentMessageVersions("session-sdk-trim", assistant?.versionGroupId ?? "");
      expect(versions[0]?.sdkMessages).toEqual([{ type: "system", subtype: "compact_boundary" }]);
    });

    test("纯非 compaction 片段持久化为 undefined", () => {
      initializeVersionStoreFromMessages("session-sdk-trim-2", []);
      const user = createUserMessageVersion({ sessionId: "session-sdk-trim-2", content: "问题", createdAt: 1 });
      const assistant = createAssistantMessageVersion({
        sessionId: "session-sdk-trim-2",
        turnId: user.turnId,
        message: {
          id: "assistant-sdk-trim-2",
          role: "assistant",
          content: "回答",
          createdAt: 2,
          sdkMessages: [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "raw" }] } }] as never
        }
      });

      // 内存返回不变;纯非 compaction 片段落盘为 undefined(store 层已覆盖同语义)
      expect(assistant?.sdkMessages).toHaveLength(1);
      const versions = getAgentMessageVersions("session-sdk-trim-2", assistant?.versionGroupId ?? "");
      expect(versions[0]?.sdkMessages).toBeUndefined();
    });
  });
});
