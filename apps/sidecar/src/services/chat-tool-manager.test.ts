import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getAllChatToolInfos,
  getChatToolCredentials,
  updateChatToolCredentials,
  updateChatToolState
} from "./chat-tool-manager";

describe("chat-tool-manager", () => {
  let tempConfigDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-chat-tool-manager-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
  });

  test("应返回默认工具列表并包含 memory_search/web_search", () => {
    const tools = getAllChatToolInfos();
    expect(tools.some((item) => item.meta.id === "memory_search")).toBeTrue();
    expect(tools.some((item) => item.meta.id === "web_search")).toBeTrue();
  });

  test("应支持更新工具开关状态", () => {
    updateChatToolState("web_search", { enabled: true });
    const tools = getAllChatToolInfos();
    const webSearch = tools.find((item) => item.meta.id === "web_search");
    expect(webSearch?.enabled).toBeTrue();
  });

  test("应支持更新并读取工具凭据", () => {
    updateChatToolCredentials("web_search", {
      braveApiKey: "brave-key",
      tavilyApiKey: "tavily-key"
    });
    const credentials = getChatToolCredentials("web_search");
    expect(credentials.braveApiKey).toBe("brave-key");
    expect(credentials.tavilyApiKey).toBe("tavily-key");
  });
});
