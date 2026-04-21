import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getWorkspaceResourcesPath } from "../infra/config-paths";
import {
  copyFolderToSession,
  copyFolderToWorkspace,
  deleteAgentFile,
  deleteWorkspaceFile,
  getAgentSessionPath,
  listAttachedDirectory,
  listAgentDirectory,
  listWorkspaceDirectory,
  moveAttachedPath,
  renameAttachedPath,
  moveAgentFile,
  moveWorkspaceFile,
  renameAgentFile,
  renameWorkspaceFile,
  resolveWorkspaceSlugBySessionId,
  saveFilesToAgentSession,
  saveFilesToWorkspace,
  searchAgentWorkspaceFiles,
  deleteAgentPlan,
  listAgentPlans,
  readAgentPlan
} from "./agent-files-service";

const createdDirs: string[] = [];
const originalConfigDir = process.env.LUME_CONFIG_DIR;

function createTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lume-agent-files-"));
  createdDirs.push(dir);
  process.env.LUME_CONFIG_DIR = dir;
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.LUME_CONFIG_DIR = originalConfigDir;
});

describe("agent-files-service plans", () => {
  test("应支持 list/read/delete plan 文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-a";
    const sessionId = "session-a";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const plansDir = join(sessionDir, "plans");
    mkdirSync(plansDir, { recursive: true });

    const planFileName = "20260218-demo-plan.md";
    const planPath = join(plansDir, planFileName);
    writeFileSync(
      planPath,
      "---\nsummary: \"演示计划\"\ncreated: 2026-02-18T00:00:00.000Z\nslug: 20260218-demo-plan\n---\n# Plan\nstep 1\n",
      "utf-8"
    );
    writeFileSync(join(plansDir, "plan.md"), "# latest\n", "utf-8");

    const plans = listAgentPlans(workspaceSlug, sessionId);
    expect(plans.length).toBe(2);
    expect(plans.some((item) => item.name === planFileName)).toBeTrue();
    const targetPlan = plans.find((item) => item.name === planFileName);
    expect(targetPlan?.summary).toBe("演示计划");

    const readResult = readAgentPlan(workspaceSlug, sessionId, planFileName);
    expect(readResult.path.endsWith(`/plans/${planFileName}`) || readResult.path.endsWith(`\\plans\\${planFileName}`)).toBeTrue();
    expect(readResult.content.includes("step 1")).toBeTrue();

    const deleteResult = deleteAgentPlan(workspaceSlug, sessionId, planFileName);
    expect(deleteResult.ok).toBeTrue();
    const remaining = listAgentPlans(workspaceSlug, sessionId);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.name).toBe("plan.md");
  });

  test("应拒绝读取越界 plan 路径", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-b";
    const sessionId = "session-b";
    getAgentSessionPath(workspaceSlug, sessionId);

    expect(() => readAgentPlan(workspaceSlug, sessionId, "../secrets.md")).toThrow(
      "Plan 路径超出线程 plans 目录"
    );
  });
});

describe("agent-files-service file ops", () => {
  test("应通过 threads/<threadId> 新目录结构解析 workspace slug", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-thread-root";
    const sessionId = "session-thread-root";
    getAgentSessionPath(workspaceSlug, sessionId);

    expect(resolveWorkspaceSlugBySessionId(sessionId)).toBe(workspaceSlug);
  });

  test("应支持重命名文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-c";
    const sessionId = "session-c";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const filePath = join(sessionDir, "old-name.txt");
    writeFileSync(filePath, "hello", "utf-8");

    const result = renameAgentFile(workspaceSlug, sessionId, filePath, "new-name.txt");
    expect(result.ok).toBeTrue();
    expect(existsSync(result.path)).toBeTrue();
    expect(readdirSync(sessionDir)).toContain("new-name.txt");
    expect(readdirSync(sessionDir)).not.toContain("old-name.txt");
  });

  test("应支持移动文件到目标目录", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-d";
    const sessionId = "session-d";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const sourceDir = join(sessionDir, "src");
    const targetDir = join(sessionDir, "dst");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    const sourcePath = join(sourceDir, "task.md");
    writeFileSync(sourcePath, "# task", "utf-8");

    const result = moveAgentFile(workspaceSlug, sessionId, sourcePath, targetDir);
    expect(result.ok).toBeTrue();
    expect(existsSync(result.path)).toBeTrue();
    expect(existsSync(sourcePath)).toBeFalse();
  });

  test("应支持搜索工作区文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-e";
    const sessionId = "session-e";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const docsDir = join(sessionDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(sessionDir, "README.md"), "root", "utf-8");
    writeFileSync(join(docsDir, "agent-guide.md"), "guide", "utf-8");
    writeFileSync(join(docsDir, "notes.txt"), "notes", "utf-8");

    const result = searchAgentWorkspaceFiles(workspaceSlug, sessionId, "ag", 20, sessionDir);
    expect(result.total).toBeGreaterThan(0);
    expect(result.entries.some((entry) => entry.name === "agent-guide.md")).toBeTrue();
  });

  test("应支持附加目录列出/重命名/移动", () => {
    createTempConfigDir();
    const tempRoot = mkdtempSync(join(tmpdir(), "lume-attached-"));
    createdDirs.push(tempRoot);
    const docsDir = join(tempRoot, "docs");
    const movedDir = join(tempRoot, "moved");
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(movedDir, { recursive: true });
    const sourceFile = join(docsDir, "todo.txt");
    writeFileSync(sourceFile, "todo", "utf-8");

    const listed = listAttachedDirectory(docsDir);
    expect(listed.length).toBe(1);
    expect(listed[0]?.name).toBe("todo.txt");

    const renamed = renameAttachedPath(sourceFile, "tasks.txt");
    expect(renamed.ok).toBeTrue();
    expect(existsSync(renamed.path)).toBeTrue();
    expect(existsSync(sourceFile)).toBeFalse();

    const moved = moveAttachedPath(renamed.path, movedDir);
    expect(moved.ok).toBeTrue();
    expect(existsSync(moved.path)).toBeTrue();
    expect(existsSync(renamed.path)).toBeFalse();
  });

  test("saveFilesToAgentSession 应记录外部附加元信息并反映到列表", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-f";
    const sessionId = "session-f";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const sourceRoot = mkdtempSync(join(tmpdir(), "lume-agent-files-src-"));
    const sourcePath = join(sourceRoot, "brief.md");
    createdDirs.push(sourceRoot);
    writeFileSync(sourcePath, "# brief", "utf-8");

    saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      files: [{ filename: "brief.md", sourcePath }]
    });

    const entries = listAgentDirectory(workspaceSlug, sessionId);
    const entry = entries.find((item) => item.name === "brief.md");
    expect(entry?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: sourcePath
    });
    expect(existsSync(join(sessionDir, "brief.md"))).toBeTrue();
  });

  test("saveFilesToWorkspace 应记录外部附加元信息并反映到列表", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-g";
    const sourceRoot = mkdtempSync(join(tmpdir(), "lume-workspace-files-src-"));
    const sourcePath = join(sourceRoot, "guide.md");
    createdDirs.push(sourceRoot);
    writeFileSync(sourcePath, "# guide", "utf-8");

    saveFilesToWorkspace({
      workspaceSlug,
      files: [{ filename: "guide.md", sourcePath }]
    });

    const entries = listWorkspaceDirectory(workspaceSlug);
    const entry = entries.find((item) => item.name === "guide.md");
    expect(entry?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: sourcePath
    });
  });

  test("copyFolderToSession 应复制文件夹并为根目录记录外部附加元信息", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-h";
    const sessionId = "session-h";
    const sourceRoot = mkdtempSync(join(tmpdir(), "lume-folder-src-"));
    createdDirs.push(sourceRoot);
    writeFileSync(join(sourceRoot, "note.txt"), "hello", "utf-8");

    copyFolderToSession({
      workspaceSlug,
      threadId: sessionId,
      sourcePath: sourceRoot
    });

    const entries = listAgentDirectory(workspaceSlug, sessionId);
    const folderName = sourceRoot.split(/[\\/]/).filter(Boolean).pop();
    const entry = entries.find((item) => item.name === folderName);
    expect(entry?.isDirectory).toBeTrue();
    expect(entry?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: sourceRoot
    });
  });

  test("copyFolderToWorkspace 应复制文件夹并为根目录记录外部附加元信息", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-i";
    const sourceRoot = mkdtempSync(join(tmpdir(), "lume-folder-ws-src-"));
    createdDirs.push(sourceRoot);
    writeFileSync(join(sourceRoot, "note.txt"), "hello", "utf-8");

    copyFolderToWorkspace({
      workspaceSlug,
      sourcePath: sourceRoot
    });

    const entries = listWorkspaceDirectory(workspaceSlug);
    const folderName = sourceRoot.split(/[\\/]/).filter(Boolean).pop();
    const entry = entries.find((item) => item.name === folderName);
    expect(entry?.isDirectory).toBeTrue();
    expect(entry?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: sourceRoot
    });
  });

  test("rename/move/delete 应同步外部附加元信息", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-j";
    const sessionId = "session-j";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const nestedDir = join(sessionDir, "docs");
    const sourceRoot = mkdtempSync(join(tmpdir(), "lume-agent-files-rename-src-"));
    const sourcePath = join(sourceRoot, "note.md");
    createdDirs.push(sourceRoot);
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(sourcePath, "# note", "utf-8");

    saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      files: [{ filename: "docs/note.md", sourcePath }]
    });

    const renamed = renameAgentFile(workspaceSlug, sessionId, join(nestedDir, "note.md"), "renamed.md");
    let docsEntries = listAgentDirectory(workspaceSlug, sessionId, nestedDir);
    expect(docsEntries.find((item) => item.name === "renamed.md")?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: sourcePath
    });

    const archiveDir = join(sessionDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    moveAgentFile(workspaceSlug, sessionId, renamed.path, archiveDir);
    let archiveEntries = listAgentDirectory(workspaceSlug, sessionId, archiveDir);
    expect(archiveEntries.find((item) => item.name === "renamed.md")?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: sourcePath
    });

    deleteAgentFile(workspaceSlug, sessionId, join(archiveDir, "renamed.md"));
    archiveEntries = listAgentDirectory(workspaceSlug, sessionId, archiveDir);
    expect(archiveEntries.find((item) => item.name === "renamed.md")).toBeUndefined();
  });

  test("workspace rename/move/delete 应同步外部附加元信息", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-k";
    const resourcesDir = getWorkspaceResourcesPath(workspaceSlug);
    const sourceRoot = mkdtempSync(join(tmpdir(), "lume-workspace-rename-src-"));
    const sourcePath = join(sourceRoot, "report.md");
    createdDirs.push(sourceRoot);
    writeFileSync(sourcePath, "# report", "utf-8");

    saveFilesToWorkspace({
      workspaceSlug,
      files: [{ filename: "report.md", sourcePath }]
    });

    const renamed = renameWorkspaceFile(workspaceSlug, join(resourcesDir, "report.md"), "report-final.md");
    let entries = listWorkspaceDirectory(workspaceSlug);
    expect(entries.find((item) => item.name === "report-final.md")?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: sourcePath
    });

    const archiveDir = join(resourcesDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    moveWorkspaceFile(workspaceSlug, renamed.path, archiveDir);
    entries = listWorkspaceDirectory(workspaceSlug, archiveDir);
    expect(entries.find((item) => item.name === "report-final.md")?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: sourcePath
    });

    deleteWorkspaceFile(workspaceSlug, join(archiveDir, "report-final.md"));
    entries = listWorkspaceDirectory(workspaceSlug, archiveDir);
    expect(entries.find((item) => item.name === "report-final.md")).toBeUndefined();
  });
});
