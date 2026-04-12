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

  test("mergeServerMessagesWithPending 应收敛为最新 user/assistant 链", () => {
    const prev: AgentMessage[] = [
      {
        id: "user-old",
        role: "user",
        content: "你是谁？",
        createdAt: 1
      },
      {
        id: "temp-1",
        role: "user",
        content: "你是谁？",
        createdAt: 2,
        metadata: { pendingClientMessageId: "pending-1" }
      },
      {
        id: "assistant-temp",
        role: "assistant",
        content: "你好",
        createdAt: 3,
        versionGroupId: "assistant-group"
      }
    ];
    const next: AgentMessage[] = [
      {
        id: "user-new",
        role: "user",
        content: "你是谁？",
        createdAt: 4,
        metadata: { pendingClientMessageId: "pending-1" }
      },
      {
        id: "assistant-new",
        role: "assistant",
        content: "你好，我是...",
        createdAt: 5,
        versionGroupId: "assistant-group"
      }
    ];

    const merged = mergeServerMessagesWithPending(prev, next);

    expect(merged.map((message) => message.id)).toEqual(["user-new", "assistant-new"]);
  });

  test("mergeServerMessagesWithPending 在服务端丢失 pendingClientMessageId 时应回退到内容和时间匹配", () => {
    const prev: AgentMessage[] = [
      {
        id: "temp-1",
        role: "user",
        content: "你是谁？",
        createdAt: 10,
        metadata: { pendingClientMessageId: "pending-1" }
      }
    ];
    const next: AgentMessage[] = [
      {
        id: "user-new",
        role: "user",
        content: "你是谁？",
        createdAt: 11
      }
    ];

    const merged = mergeServerMessagesWithPending(prev, next);

    expect(merged.map((message) => message.id)).toEqual(["user-new"]);
  });

  test("mergeServerMessagesWithPending 不应把更早的同内容旧消息误判为 temp 的落盘结果", () => {
    const prev: AgentMessage[] = [
      {
        id: "temp-1",
        role: "user",
        content: "你是谁？",
        createdAt: 10,
        metadata: { pendingClientMessageId: "pending-1" }
      }
    ];
    const next: AgentMessage[] = [
      {
        id: "user-old",
        role: "user",
        content: "你是谁？",
        createdAt: 9
      }
    ];

    const merged = mergeServerMessagesWithPending(prev, next);

    expect(merged.map((message) => message.id)).toEqual(["user-old", "temp-1"]);
  });

  test("mergeServerMessagesWithPending 对未变化消息应复用旧对象引用", () => {
    const prevMessage: AgentMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "稳定内容",
      createdAt: 1,
      metadata: { foo: "bar" }
    };

    const merged = mergeServerMessagesWithPending([prevMessage], [{
      id: "assistant-1",
      role: "assistant",
      content: "稳定内容",
      createdAt: 1,
      metadata: { foo: "bar" }
    }]);

    expect(merged[0]).toBe(prevMessage);
  });

  test("mergeServerMessagesWithPending 对变化消息不应复用旧对象引用", () => {
    const prevMessage: AgentMessage = {
      id: "assistant-1",
      role: "assistant",
      content: "旧内容",
      createdAt: 1
    };

    const merged = mergeServerMessagesWithPending([prevMessage], [{
      id: "assistant-1",
      role: "assistant",
      content: "新内容",
      createdAt: 1
    }]);

    expect(merged[0]).not.toBe(prevMessage);
  });

  test("mergeServerMessagesWithPending 应保留本地固化的失败 assistant 消息", () => {
    const prev: AgentMessage[] = [
      {
        id: "assistant-error-local",
        role: "assistant",
        content: "已经生成的一部分内容",
        createdAt: 10,
        metadata: {
          streamErrorPreserved: true
        }
      }
    ];

    const merged = mergeServerMessagesWithPending(prev, []);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("assistant-error-local");
    expect((merged[0]?.metadata as Record<string, unknown> | undefined)?.streamErrorPreserved).toBe(true);
  });
});
