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
  readAgentPath,
  resolveThreadAttachmentPath,
  resolveWorkspaceSlugBySessionId,
  saveFilesToAgentSession,
  saveFilesToWorkspace,
  searchAgentWorkspaceFiles,
  toThreadRelativePath
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

  test("readAgentPath 应支持线程工作区相对路径并拒绝越界路径", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-plan-relative";
    const sessionId = "session-plan-relative";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    mkdirSync(join(sessionDir, "plans"), { recursive: true });
    writeFileSync(join(sessionDir, "plans", "plan.md"), "# plan", "utf-8");

    expect(readAgentPath(workspaceSlug, sessionId, "plans/plan.md")).toEqual({
      content: "# plan",
      truncated: false
    });
    expect(() => readAgentPath(workspaceSlug, sessionId, "../plan.md")).toThrow("目标路径超出线程工作目录");
  });

  test("线程附件路径 helper 应转换线程内路径并拒绝越界或缺失文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-attachment-paths";
    const sessionId = "session-attachment-paths";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const docsDir = join(sessionDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    const filePath = join(docsDir, "brief.md");
    writeFileSync(filePath, "# brief", "utf-8");

    expect(toThreadRelativePath(workspaceSlug, sessionId, filePath)).toBe("docs/brief.md");
    expect(resolveThreadAttachmentPath(workspaceSlug, sessionId, "docs/brief.md")).toBe(filePath);
    expect(() => resolveThreadAttachmentPath(workspaceSlug, sessionId, "../brief.md"))
      .toThrow("目标路径超出线程工作目录");
    expect(() => resolveThreadAttachmentPath(workspaceSlug, sessionId, "missing.md"))
      .toThrow("附件文件不存在");
    expect(() => toThreadRelativePath(workspaceSlug, sessionId, join(tmpdir(), "outside.md")))
      .toThrow("附件路径不在当前线程目录内");
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

    const saved = saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      files: [{ filename: "brief.md", sourcePath }]
    });

    expect(saved[0]?.threadPath).toBe("brief.md");
    const entries = listAgentDirectory(workspaceSlug, sessionId);
    const entry = entries.find((item) => item.name === "brief.md");
    expect(entry?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: sourcePath
    });
    expect(existsSync(join(sessionDir, "brief.md"))).toBeTrue();
  });

  test("agent 产出文件不应保留旧的外部附加元信息", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-f2";
    const sessionId = "session-f2";
    const sourceRoot = mkdtempSync(join(tmpdir(), "lume-agent-files-src-"));
    const sourcePath = join(sourceRoot, "brief.md");
    createdDirs.push(sourceRoot);
    writeFileSync(sourcePath, "# brief", "utf-8");

    saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      files: [{ filename: "brief.md", sourcePath }]
    });
    saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      files: [{ filename: "brief.md", data: Buffer.from("# generated").toString("base64") }]
    });

    const entry = listAgentDirectory(workspaceSlug, sessionId).find((item) => item.name === "brief.md");
    expect(entry?.externalAttachment).toBeUndefined();
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

  test("workspace 内部 sourcePath 不应被标记为外部附加", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-g3";
    const resourcesDir = getWorkspaceResourcesPath(workspaceSlug);
    const internalSource = join(resourcesDir, "internal.md");
    writeFileSync(internalSource, "# internal", "utf-8");

    saveFilesToWorkspace({
      workspaceSlug,
      files: [{ filename: "copied.md", sourcePath: internalSource }]
    });

    const entry = listWorkspaceDirectory(workspaceSlug).find((item) => item.name === "copied.md");
    expect(entry?.externalAttachment).toBeUndefined();
  });

  test("workspace 中的 agent 产出文件不应保留旧的外部附加元信息", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-g2";
    const sourceRoot = mkdtempSync(join(tmpdir(), "lume-workspace-files-src-"));
    const sourcePath = join(sourceRoot, "guide.md");
    createdDirs.push(sourceRoot);
    writeFileSync(sourcePath, "# guide", "utf-8");

    saveFilesToWorkspace({
      workspaceSlug,
      files: [{ filename: "guide.md", sourcePath }]
    });
    saveFilesToWorkspace({
      workspaceSlug,
      files: [{ filename: "guide.md", data: Buffer.from("# generated").toString("base64") }]
    });

    const entry = listWorkspaceDirectory(workspaceSlug).find((item) => item.name === "guide.md");
    expect(entry?.externalAttachment).toBeUndefined();
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

  test("copyFolderToSession 应拒绝文件 sourcePath 和同名目标目录", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-h2";
    const sessionId = "session-h2";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const fileSourceRoot = mkdtempSync(join(tmpdir(), "lume-folder-file-src-"));
    const fileSource = join(fileSourceRoot, "single.txt");
    const folderSourceRoot = mkdtempSync(join(tmpdir(), "lume-folder-existing-src-"));
    createdDirs.push(fileSourceRoot, folderSourceRoot);
    writeFileSync(fileSource, "hello", "utf-8");
    writeFileSync(join(folderSourceRoot, "note.txt"), "hello", "utf-8");
    mkdirSync(join(sessionDir, folderSourceRoot.split(/[\\/]/).filter(Boolean).pop() as string), { recursive: true });

    expect(() => copyFolderToSession({
      workspaceSlug,
      threadId: sessionId,
      sourcePath: fileSource
    })).toThrow("源目录不存在");

    expect(() => copyFolderToSession({
      workspaceSlug,
      threadId: sessionId,
      sourcePath: folderSourceRoot
    })).toThrow("目标路径已存在同名文件");
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

  test("copyFolderToWorkspace 应拒绝文件 sourcePath 和同名目标目录", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-i2";
    const resourcesDir = getWorkspaceResourcesPath(workspaceSlug);
    const fileSourceRoot = mkdtempSync(join(tmpdir(), "lume-ws-folder-file-src-"));
    const fileSource = join(fileSourceRoot, "single.txt");
    const folderSourceRoot = mkdtempSync(join(tmpdir(), "lume-ws-folder-existing-src-"));
    createdDirs.push(fileSourceRoot, folderSourceRoot);
    writeFileSync(fileSource, "hello", "utf-8");
    writeFileSync(join(folderSourceRoot, "note.txt"), "hello", "utf-8");
    mkdirSync(join(resourcesDir, folderSourceRoot.split(/[\\/]/).filter(Boolean).pop() as string), { recursive: true });

    expect(() => copyFolderToWorkspace({
      workspaceSlug,
      sourcePath: fileSource
    })).toThrow("源目录不存在");

    expect(() => copyFolderToWorkspace({
      workspaceSlug,
      sourcePath: folderSourceRoot
    })).toThrow("目标路径已存在同名文件");
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
