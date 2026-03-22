import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CHAT_TOOL_IPC_CHANNELS } from "@lume/shared";
import { getChatToolsPath } from "./config-paths";
import { getAllChatToolInfos } from "./chat-tool-manager";
import { startChatToolsWatcher, stopChatToolsWatcher } from "./chat-tools-watcher";

describe("chat-tools-watcher", () => {
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-chat-tools-watcher-"));
    // 先初始化默认配置文件
    getAllChatToolInfos();
  });

  afterEach(() => {
    stopChatToolsWatcher();
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
  });

  test("外部修改 chat-tools.json 时应发出 CUSTOM_TOOL_CHANGED 事件", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    startChatToolsWatcher((method, params) => {
      notifications.push({ method, params });
    });

    const filePath = getChatToolsPath();
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      toolStates: {
        memory_search: { enabled: true },
        web_search: { enabled: false }
      },
      toolCredentials: {},
      customTools: []
    }, null, 2));

    const startedAt = Date.now();
    while (Date.now() - startedAt < 3000) {
      if (notifications.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const changedEvent = notifications.find((item) => item.method === CHAT_TOOL_IPC_CHANNELS.CUSTOM_TOOL_CHANGED);
    expect(changedEvent).toBeDefined();
    expect(changedEvent?.params).toMatchObject({
      toolId: "*",
      changeType: "external"
    });
  });
});
