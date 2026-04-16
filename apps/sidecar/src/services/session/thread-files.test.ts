import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentThread } from "../agent/agent-thread-manager";
import { createAgentWorkspace } from "../agent/agent-workspace-manager";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDirPath
} from "../pi-agent/runtime-core/session-store";
import { listThreadEntriesForWorkspace } from "./thread-files";

describe("memory thread-files", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-memory-thread-files-"));
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

  test("应支持仅 transcript 的 thread 索引", () => {
    const workspace = createAgentWorkspace("记忆工作区");
    const thread = createAgentThread("transcript only", undefined, workspace.id);
    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), thread.id);

    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "第一条 用户 消息" }],
      timestamp: 100
    });
    sessionManager.appendMessage({
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: "第二条 助手 回复" }],
      timestamp: 200
    });

    const entries = listThreadEntriesForWorkspace(workspace.id);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe(`threads/${thread.id}`);
    expect(entries[0]?.absPath).toBe(getRuntimeCoreSessionDirPath(thread.id));
    expect(entries[0]?.content).toContain("User: 第一条 用户 消息");
    expect(entries[0]?.content).toContain("Assistant: 第二条 助手 回复");
    expect(entries[0]?.lineMap).toEqual([1, 2]);
    expect(entries[0]?.size).toBeGreaterThan(0);
    expect(entries[0]?.mtimeMs).toBe(200);
  });
});
