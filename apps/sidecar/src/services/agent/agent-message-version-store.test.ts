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
});
