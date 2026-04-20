import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanStateTracker } from "../services/agent/plan-state-tracker";
import { createAgentHandlers } from "./agent-handlers";
import { createAgentWorkspace } from "../services/agent/agent-workspace-manager";
import { createAgentThread } from "../services/agent/agent-thread-manager";
import { getAgentSessionWorkspacePath } from "../services/infra/config-paths";

function createTestPlanStateTracker(): PlanStateTracker {
  return {
    isLikelyExecutionRequest: () => false,
    syncExecutionFromUserMessage: () => undefined,
    getPhase: () => "idle",
    markCurrentStepCompleted: () => undefined,
    markCurrentStepFailed: () => undefined,
    clearSession: () => undefined,
  } as unknown as PlanStateTracker;
}

describe("agent-handlers file operations", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
  });

  test("LIST_DIRECTORY 在省略 workspaceSlug 时应按 threadId 解析当前工作区线程目录", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-agent-handlers-files-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspace = createAgentWorkspace("Default");
    const thread = createAgentThread("file tree thread", undefined, workspace.id);
    const threadDir = getAgentSessionWorkspacePath(workspace.slug, thread.id);
    writeFileSync(join(threadDir, "scratch.txt"), "hello", "utf-8");

    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planStateTracker: createTestPlanStateTracker(),
      notifyPlanStateChange: () => undefined,
    });

    const result = await handlers[AGENT_IPC_CHANNELS.LIST_DIRECTORY]!({
      threadId: thread.id,
    }) as { entries: Array<{ name: string; path: string; isDirectory: boolean }> };

    expect(result.entries.some((entry) => entry.name === "scratch.txt")).toBeTrue();

    rmSync(configDir, { recursive: true, force: true });
  });

  test("SAVE_FILES_TO_THREAD 在省略 workspaceSlug 时应保存到当前线程临时目录", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-agent-handlers-save-files-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspace = createAgentWorkspace("Default");
    const thread = createAgentThread("save files thread", undefined, workspace.id);
    const threadDir = getAgentSessionWorkspacePath(workspace.slug, thread.id);

    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planStateTracker: createTestPlanStateTracker(),
      notifyPlanStateChange: () => undefined,
    });

    const result = await handlers[AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD]!({
      threadId: thread.id,
      files: [
        {
          filename: "scratch.txt",
          data: Buffer.from("hello").toString("base64"),
        }
      ]
    }) as Array<{ filename: string; targetPath: string }>;

    expect(result[0]?.filename).toBe("scratch.txt");
    expect(result[0]?.targetPath).toBe(join(threadDir, "scratch.txt"));

    rmSync(configDir, { recursive: true, force: true });
  });
});
