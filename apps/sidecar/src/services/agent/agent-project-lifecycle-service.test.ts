import { registerRealAgentStores } from "../agent-runtime/agent-thread-store-test-adapter";
registerRealAgentStores();
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentWorkspace, getAgentWorkspace } from "./agent-workspace-manager";
import {
  createAgentThread,
  getAgentThreadMeta,
  restoreAgentThreadFromTrash
} from "./agent-thread-manager";
import { resolveAgentThreadWorkdir } from "../agent-runtime/agent-workdir-resolver";
import { removeProject } from "./agent-project-lifecycle-service";
import { resetPlanningTodoStoreForTests } from "../planning/planning-todo-store";

describe("agent-project-lifecycle-service", () => {
  let previousConfigDir: string | undefined;
  let configDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), "lume-project-lifecycle-"));
    process.env.LUME_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    resetPlanningTodoStoreForTests();
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  function createProject(name: string) {
    const projectPath = join(configDir, "projects", name);
    mkdirSync(projectPath, { recursive: true });
    return createAgentWorkspace(name, { projectPath });
  }

  test("仅移除项目会保留真实目录、会话历史和 Lume 工作目录", async () => {
    const workspace = createProject("keep");
    const thread = createAgentThread("keep thread", undefined, workspace.id);
    const workdir = resolveAgentThreadWorkdir(thread.id);
    writeFileSync(join(workdir.filesRoot, "artifact.txt"), "keep", "utf-8");
    const legacyParent = join(configDir, "agent-workspaces", workspace.slug, "threads");
    const legacyRoot = join(legacyParent, thread.id);
    mkdirSync(legacyParent, { recursive: true });
    renameSync(workdir.lumeWorkDir, legacyRoot);

    await removeProject({ workspaceId: workspace.id, mode: "keepHistory" });

    expect(getAgentWorkspace(workspace.id)).toBeUndefined();
    expect(getAgentThreadMeta(thread.id)?.id).toBe(thread.id);
    expect(getAgentThreadMeta(thread.id)?.workspaceId).toBeUndefined();
    expect(existsSync(workspace.projectPath!)).toBeTrue();
    expect(existsSync(join(workdir.filesRoot, "artifact.txt"))).toBeTrue();
  });

  test("删除 Lume 数据先进入回收站，恢复后仍是共享原文件上下文的普通归档会话", async () => {
    const workspace = createProject("trash");
    const thread = createAgentThread("trash thread", undefined, workspace.id);
    const fileContextId = thread.fileContextId;

    await removeProject({ workspaceId: workspace.id, mode: "deleteLumeData" });
    const trashed = getAgentThreadMeta(thread.id);

    expect(trashed).toMatchObject({ status: "trashed", fileContextId });
    expect(trashed?.workspaceId).toBeUndefined();
    const restored = restoreAgentThreadFromTrash(thread.id);
    expect(restored).toMatchObject({ status: "archived", fileContextId });
    expect(restored.workspaceId).toBeUndefined();
    expect(getAgentWorkspace(workspace.id)).toBeUndefined();
    expect(existsSync(workspace.projectPath!)).toBeTrue();
  });
});
