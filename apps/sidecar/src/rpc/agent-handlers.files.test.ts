import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { createAgentHandlers } from "./agent-handlers";
import { createAgentWorkspace } from "../services/agent/agent-workspace-manager";
import { createAgentThread } from "../services/agent/agent-thread-manager";
import { getAgentSessionWorkspacePath, getWorkspaceResourcesPath } from "../services/infra/config-paths";

function createTestPlanModePhaseTracker(): PlanModePhaseTracker {
  return {
    isLikelyExecutionRequest: () => false,
    getPhase: () => "idle",
    clearSession: () => undefined,
  } as unknown as PlanModePhaseTracker;
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
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined,
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
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined,
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

  test("READ_THREAD_FILE_DATA 应读取线程文件的 base64 数据", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-agent-handlers-read-file-data-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspace = createAgentWorkspace("Default");
    const thread = createAgentThread("read file data thread", undefined, workspace.id);
    const threadDir = getAgentSessionWorkspacePath(workspace.slug, thread.id);
    writeFileSync(join(threadDir, "screen.png"), "fake-image");

    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined,
    });

    const result = await handlers[AGENT_IPC_CHANNELS.READ_THREAD_FILE_DATA]!({
      threadId: thread.id,
      path: "screen.png",
    }) as { data: string; size: number };

    expect(result).toEqual({
      data: Buffer.from("fake-image").toString("base64"),
      size: Buffer.byteLength("fake-image"),
    });

    rmSync(configDir, { recursive: true, force: true });
  });

  test("READ_THREAD_FILE_DATA 应拒绝线程目录外路径", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-agent-handlers-read-file-data-safe-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspace = createAgentWorkspace("Default");
    const thread = createAgentThread("read file data safe thread", undefined, workspace.id);
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined,
    });

    await expect(handlers[AGENT_IPC_CHANNELS.READ_THREAD_FILE_DATA]!({
      threadId: thread.id,
      path: "../secret.png",
    })).rejects.toThrow();

    rmSync(configDir, { recursive: true, force: true });
  });

  test("LIST_DIRECTORY 和 LIST_WORKSPACE_DIRECTORY 应返回 externalAttachment 元信息", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-agent-handlers-list-meta-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspace = createAgentWorkspace("Default");
    const thread = createAgentThread("meta thread", undefined, workspace.id);
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined,
    });

    const externalThreadSource = join(configDir, "thread-source.txt");
    const externalWorkspaceSource = join(configDir, "workspace-source.txt");
    writeFileSync(externalThreadSource, "thread", "utf-8");
    writeFileSync(externalWorkspaceSource, "workspace", "utf-8");

    await handlers[AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD]!({
      threadId: thread.id,
      files: [{ filename: "thread.txt", sourcePath: externalThreadSource }]
    });
    await handlers[AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE]!({
      workspaceSlug: workspace.slug,
      files: [{ filename: "workspace.txt", sourcePath: externalWorkspaceSource }]
    });

    const threadResult = await handlers[AGENT_IPC_CHANNELS.LIST_DIRECTORY]!({
      threadId: thread.id,
    }) as { entries: Array<{ name: string; externalAttachment?: { absoluteSourcePath: string } }> };
    const workspaceResult = await handlers[AGENT_IPC_CHANNELS.LIST_WORKSPACE_DIRECTORY]!({
      workspaceSlug: workspace.slug,
    }) as Array<{ name: string; externalAttachment?: { absoluteSourcePath: string } }>;

    expect(threadResult.entries.find((entry) => entry.name === "thread.txt")?.externalAttachment?.absoluteSourcePath)
      .toBe(externalThreadSource);
    expect(workspaceResult.find((entry) => entry.name === "workspace.txt")?.externalAttachment?.absoluteSourcePath)
      .toBe(externalWorkspaceSource);

    rmSync(configDir, { recursive: true, force: true });
  });

  test("ATTACH_WORKSPACE_RESOURCE_TO_THREAD 应复制工作区文件到线程", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-agent-handlers-attach-file-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspace = createAgentWorkspace("Default");
    const thread = createAgentThread("attach file thread", undefined, workspace.id);
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined,
    });

    const resourcesDir = getWorkspaceResourcesPath(workspace.slug);
    const sourcePath = join(resourcesDir, "brief.md");
    writeFileSync(sourcePath, "# brief", "utf-8");

    const result = await handlers[AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_RESOURCE_TO_THREAD]!({
      workspaceSlug: workspace.slug,
      threadId: thread.id,
      sourcePath
    }) as { ok: true; path: string };

    expect(result.ok).toBeTrue();
    expect(result.path).toBe(join(getAgentSessionWorkspacePath(workspace.slug, thread.id), "brief.md"));

    rmSync(configDir, { recursive: true, force: true });
  });

  test("ATTACH_WORKSPACE_RESOURCE_TO_THREAD 应复制工作区文件夹到线程", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-agent-handlers-attach-folder-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspace = createAgentWorkspace("Default");
    const thread = createAgentThread("attach folder thread", undefined, workspace.id);
    const handlers = createAgentHandlers({
      writeNotification: () => undefined,
      planModePhaseTracker: createTestPlanModePhaseTracker(),
      notifyPlanModePhaseChange: () => undefined,
    });

    const resourcesDir = getWorkspaceResourcesPath(workspace.slug);
    const sourceDir = join(resourcesDir, "assets");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "logo.svg"), "<svg />", "utf-8");

    const result = await handlers[AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_RESOURCE_TO_THREAD]!({
      workspaceSlug: workspace.slug,
      threadId: thread.id,
      sourcePath: sourceDir
    }) as { ok: true; path: string };

    expect(result.ok).toBeTrue();
    expect(result.path).toBe(join(getAgentSessionWorkspacePath(workspace.slug, thread.id), "assets"));

    rmSync(configDir, { recursive: true, force: true });
  });
});
