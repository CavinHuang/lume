import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@lume/shared";
import { mergeServerMessagesWithPending, replaceVisibleMessage } from "./agent-message-merge";

describe("agent-message-merge", () => {
  test("replaceVisibleMessage 应使用 pendingClientMessageId 替换 temp user", () => {
    const prev: AgentMessage[] = [
      {
        id: "temp-1",
        role: "user",
        content: "hello",
        createdAt: 1,
        metadata: { pendingClientMessageId: "pending-1" }
      }
    ];
    const nextMessage: AgentMessage = {
      id: "user-1",
      role: "user",
      content: "hello",
      createdAt: 2,
      metadata: { pendingClientMessageId: "pending-1" }
    };

    const merged = replaceVisibleMessage(prev, nextMessage);

    expect(merged.length).toBe(1);
    expect(merged[0]?.id).toBe("user-1");
  });

  test("replaceVisibleMessage 应按 versionGroupId 替换 latest assistant", () => {
    const prev: AgentMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "旧回复",
        createdAt: 1,
        versionGroupId: "group-1",
        versionIndex: 1,
        versionCount: 1
      }
    ];
    const nextMessage: AgentMessage = {
      id: "assistant-2",
      role: "assistant",
      content: "新回复",
      createdAt: 2,
      versionGroupId: "group-1",
      versionIndex: 2,
      versionCount: 2,
      isLatestVersion: true
    };

    const merged = replaceVisibleMessage(prev, nextMessage);

    expect(merged.length).toBe(1);
    expect(merged[0]?.id).toBe("assistant-2");
  });

  test("mergeServerMessagesWithPending 应保留尚未落盘的 temp 消息", () => {
    const prev: AgentMessage[] = [
      {
        id: "temp-1",
        role: "user",
        content: "本地消息",
        createdAt: 1,
        metadata: { pendingClientMessageId: "pending-1" }
      }
    ];
    const merged = mergeServerMessagesWithPending(prev, []);

    expect(merged.length).toBe(1);
    expect(merged[0]?.id).toBe("temp-1");
  });

  test("mergeServerMessagesWithPending 应移除已由服务端确认的 temp 消息", () => {
    const prev: AgentMessage[] = [
      {
        id: "temp-1",
        role: "user",
        content: "本地消息",
        createdAt: 1,
        metadata: { pendingClientMessageId: "pending-1" }
      }
    ];
    const next: AgentMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "本地消息",
        createdAt: 2,
        metadata: { pendingClientMessageId: "pending-1" }
      }
    ];

    const merged = mergeServerMessagesWithPending(prev, next);

    expect(merged.length).toBe(1);
    expect(merged[0]?.id).toBe("user-1");
  });
});
