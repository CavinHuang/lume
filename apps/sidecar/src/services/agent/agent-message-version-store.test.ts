import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEmptyAgentMessageVersionStore,
  ensureAgentMessageVersionStore,
  readAgentMessageVersionStore,
  writeAgentMessageVersionStore
} from "./agent-message-version-store";

describe("agent-message-version-store", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-version-store-"));
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

  test("ensureAgentMessageVersionStore 应初始化空 store", () => {
    const store = ensureAgentMessageVersionStore("session-a");

    expect(store.version).toBe(1);
    expect(store.sessionId).toBe("session-a");
    expect(store.groups).toEqual([]);
    expect(store.messages).toEqual([]);
  });

  // #527 遗留(sdkMessages 双留存去重):全局 sdkMessages.jsonl 是原始流唯一正典,
  // 版本 store 落盘时裁剪至 compaction 子集(与传输裁剪同口径),内存对象不受影响
  test("writeAgentMessageVersionStore 落盘裁剪 sdkMessages 至 compaction 子集,重读只余 compaction", () => {
    const store = createEmptyAgentMessageVersionStore("session-trim");
    store.groups.push({
      groupId: "group-trim",
      turnId: "turn-trim",
      role: "assistant",
      latestMessageId: "message-trim",
      messageIds: ["message-trim"],
      createdAt: 1,
      updatedAt: 1
    });
    store.messages.push({
      messageId: "message-trim",
      groupId: "group-trim",
      role: "assistant",
      versionIndex: 1,
      isLatestVersion: true,
      createdAt: 1,
      content: "回答",
      sdkMessages: [
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "raw" }] } },
        { type: "system", subtype: "compact_boundary" },
        { type: "system", subtype: "unrelated" }
      ] as never
    });

    writeAgentMessageVersionStore("session-trim", store);
    const loaded = readAgentMessageVersionStore("session-trim");

    expect(loaded?.messages[0]?.sdkMessages).toEqual([{ type: "system", subtype: "compact_boundary" }]);
    // 内存对象不受写盘裁剪影响(内部链路语义不变)
    expect(store.messages[0]?.sdkMessages).toHaveLength(3);
  });

  test("write/read 应保持 store 内容一致", () => {
    const store = createEmptyAgentMessageVersionStore("session-b");
    store.groups.push({
      groupId: "group-1",
      turnId: "turn-1",
      role: "user",
      latestMessageId: "message-1",
      messageIds: ["message-1"],
      createdAt: 1,
      updatedAt: 1
    });
    store.messages.push({
      messageId: "message-1",
      groupId: "group-1",
      role: "user",
      versionIndex: 1,
      isLatestVersion: true,
      createdAt: 1,
      content: "hello"
    });
    store.visibleGroupIds.push("group-1");

    writeAgentMessageVersionStore("session-b", store);
    const loaded = readAgentMessageVersionStore("session-b");

    expect(loaded?.version).toBe(1);
    expect(loaded?.groups.length).toBe(1);
    expect(loaded?.messages[0]?.content).toBe("hello");
    expect(loaded?.visibleGroupIds).toEqual(["group-1"]);
  });

  // #527-1：超限时最旧的不可见组连同其消息被裁剪；可见组与其消息永不触碰
  test("超 300 组写入时裁剪最旧不可见组，可见链完整保留", () => {
    const store = createEmptyAgentMessageVersionStore("session-prune");
    const visibleIds: string[] = [];
    for (let i = 0; i < 310; i += 1) {
      const groupId = `group-${i}`;
      const messageId = `message-${i}`;
      store.groups.push({
        groupId,
        turnId: `turn-${i}`,
        role: "user",
        latestMessageId: messageId,
        messageIds: [messageId],
        createdAt: i,
        updatedAt: i
      });
      store.messages.push({
        messageId,
        groupId,
        role: "user",
        versionIndex: 1,
        isLatestVersion: true,
        createdAt: i,
        content: `content-${i}`
      });
      if (i >= 300) visibleIds.push(groupId); // 最新的 10 组可见，300 个旧组不可见
    }
    store.visibleGroupIds.push(...visibleIds);

    writeAgentMessageVersionStore("session-prune", store);
    const loaded = readAgentMessageVersionStore("session-prune");

    expect(loaded?.groups.length).toBe(300);
    expect(loaded?.visibleGroupIds).toEqual(visibleIds);
    // 被裁的是最旧不可见段 group-0..9；最新可见组的消息必须原样保留
    expect(loaded?.groups.map((group) => group.groupId)).not.toContain("group-0");
    expect(loaded?.groups.at(-1)?.groupId).toBe("group-309");
    expect(
      loaded?.messages.find((record) => record.messageId === "message-309")?.content
    ).toBe("content-309");
    // 被裁组（group-0..9）的消息必须级联消失
    expect(loaded?.messages.some((record) => /^group-\d+$/.test(record.groupId) && Number(record.groupId.slice(6)) < 10)).toBe(false);
  });

  test("未超限的 store 不触发任何裁剪", () => {
    const store = createEmptyAgentMessageVersionStore("session-small");
    store.groups.push({
      groupId: "g1",
      turnId: "t1",
      role: "user",
      latestMessageId: "m1",
      messageIds: ["m1"],
      createdAt: 1,
      updatedAt: 2
    });
    store.visibleGroupIds.push("g1");
    writeAgentMessageVersionStore("session-small", store);
    expect(readAgentMessageVersionStore("session-small")?.groups.length).toBe(1);
  });
});
