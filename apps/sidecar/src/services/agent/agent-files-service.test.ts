import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getWorkspaceResourcesPath } from "../infra/config-paths";
import {
  copyFolderToSession,
  copyFolderToWorkspace,
  convertLegacyFileRef,
  createFileReferenceBinding,
  deleteAgentFile,
  deleteWorkspaceFile,
  exportLegacyResourceToProject,
  getAgentSessionPath,
  listAgentDirectory,
  listProjectDirectory,
  listWorkspaceRootDirectory,
  listWorkspaceDirectory,
  moveAuthorizedFileRef,
  moveAgentFile,
  moveWorkspaceFile,
  renameAgentFile,
  renameWorkspaceFile,
  readAgentPath,
  readGuardedFileRef,
  readWorkspaceRootPath,
  renameAuthorizedFileRef,
  resolveAuthorizedFileRef,
  validateGuardedFileRef,
  resolveThreadAttachmentPath,
  resolveWorkspaceSlugBySessionId,
  saveFilesToAgentSession,
  saveFilesToWorkspaceRoot,
  saveFilesToWorkspace,
  searchAgentWorkspaceFiles,
  searchAuthorizedFiles,
  statAuthorizedFileRef,
  toThreadRelativePath
} from "./agent-files-service";
import { createAgentWorkspace, relocateUnavailableAgentWorkspace } from "./agent-workspace-manager";
import { createAgentThread } from "./agent-thread-manager";
import { resolveAgentThreadWorkdir } from "./agent-workdir-resolver";
import { listMemorySourceFiles, memoryFileRefForPath } from "../memory-v2/source-files";
import { getMemoryV2ScopePaths } from "../memory-v2/paths";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "../system/workspace-watcher";
import { MEMORY_IPC_CHANNELS } from "@lume/shared";

const createdDirs: string[] = [];
const originalConfigDir = process.env.LUME_CONFIG_DIR;

function createTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lume-agent-files-"));
  createdDirs.push(dir);
  process.env.LUME_CONFIG_DIR = dir;
  return dir;
}

afterEach(() => {
  stopWorkspaceWatcher();
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.LUME_CONFIG_DIR = originalConfigDir;
});

describe("agent-files-service file ops", () => {
  test("emits the memory-specific change event for the global memory root", async () => {
    createTempConfigDir();
    const global = getMemoryV2ScopePaths({ scope: "global" });
    let resolveChanged!: () => void;
    const changed = new Promise<void>((resolve) => { resolveChanged = resolve; });
    startWorkspaceWatcher((method) => {
      if (method === MEMORY_IPC_CHANNELS.SOURCE_FILES_CHANGED) resolveChanged();
    });
    writeFileSync(join(global.dailyDir, "watch.md"), "changed", "utf-8");
    const result = await Promise.race([
      changed.then(() => "changed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
    ]);
    expect(result).toBe("changed");
  });

  test("paginates the complete workspace and global memory source file list", () => {
    createTempConfigDir();
    const workspace = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" });
    const global = getMemoryV2ScopePaths({ scope: "global" });
    writeFileSync(workspace.memoryMd, "workspace", "utf-8");
    writeFileSync(join(workspace.dailyDir, "2026-07-15.md"), "daily", "utf-8");
    writeFileSync(join(workspace.runsDir!, "run.md"), "run", "utf-8");
    writeFileSync(global.memoryMd, "global", "utf-8");

    const first = listMemorySourceFiles({ workspaceSlug: "demo", limit: 2 });
    const second = listMemorySourceFiles({ workspaceSlug: "demo", cursor: first.nextCursor, limit: 2 });

    expect(first.entries).toHaveLength(2);
    expect(second.entries).toHaveLength(2);
    expect([...first.entries, ...second.entries].map((entry) => entry.ref)).toEqual(expect.arrayContaining([
      { source: "memory", scopeId: "workspace:demo", relativePath: "MEMORY.md" },
      { source: "memory", scopeId: "workspace:demo", relativePath: "daily/2026-07-15.md" },
      { source: "memory", scopeId: "workspace:demo", relativePath: "runs/run.md" },
      { source: "memory", scopeId: "global", relativePath: "MEMORY.md" },
    ]));
    expect(first.entries.every((entry) => typeof entry.modifiedAt === "string")).toBe(true);
    expect(second.nextCursor).toBeUndefined();
    expect(memoryFileRefForPath({ scope: "workspace", workspaceSlug: "demo", path: `${workspace.memoryMd}#L1` })).toEqual({
      source: "memory", scopeId: "workspace:demo", relativePath: "MEMORY.md",
    });
    expect(memoryFileRefForPath({ scope: "global", path: global.memoryMd })).toEqual({
      source: "memory", scopeId: "global", relativePath: "MEMORY.md",
    });
  });

  test("FileRef resolver normalizes paths, returns metadata, and rejects symlink escape", async () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-ref");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("project-ref", { projectPath });
    writeFileSync(join(projectPath, ".visible.md"), "dot", "utf-8");
    mkdirSync(join(projectPath, "node_modules"));
    writeFileSync(join(projectPath, "node_modules", "hidden.md"), "hidden", "utf-8");

    const resolved = resolveAuthorizedFileRef({ source: "project", scopeId: workspace.slug, relativePath: "./.visible.md" });
    expect(resolved.relativePath).toBe(".visible.md");
    expect(resolved.absolutePath).toBe(join(projectPath, ".visible.md"));

    const listed = listProjectDirectory(workspace.slug);
    expect(listed.find((entry) => entry.name === ".visible.md")).toMatchObject({
      ref: { source: "project", scopeId: workspace.slug, relativePath: ".visible.md" },
      size: 3,
    });
    expect(listed.find((entry) => entry.name === ".visible.md")?.modifiedAt).toBeString();
    expect(statAuthorizedFileRef({ source: "project", scopeId: workspace.slug, relativePath: ".visible.md" })).toMatchObject({
      name: ".visible.md",
      path: ".visible.md",
      size: 3,
      modifiedAt: expect.any(String),
    });

    const search = await searchAuthorizedFiles(
      { source: "project", scopeId: workspace.slug, relativePath: "" },
      ".visible",
      { limit: 200 },
    );
    expect(search.entries.map((entry) => entry.path)).toContain(".visible.md");
    expect(search.entries.map((entry) => entry.path)).not.toContain("node_modules/hidden.md");
    const included = await searchAuthorizedFiles(
      { source: "project", scopeId: workspace.slug, relativePath: "" },
      "hidden",
      { includeExcluded: true },
    );
    expect(included.entries.map((entry) => entry.path)).toContain("node_modules/hidden.md");

    const manyDir = join(projectPath, "many");
    mkdirSync(manyDir);
    for (let index = 0; index < 205; index += 1) writeFileSync(join(manyDir, `match-${index}.txt`), "x", "utf-8");
    const capped = await searchAuthorizedFiles(
      { source: "project", scopeId: workspace.slug, relativePath: "" },
      "match-",
      { limit: 200 },
    );
    expect(capped.entries).toHaveLength(200);
    expect(capped.truncated).toBe(true);
    const budgeted = await searchAuthorizedFiles(
      { source: "project", scopeId: workspace.slug, relativePath: "" },
      "match-",
      { limit: 1, maxEntries: 1 },
    );
    expect(budgeted.truncated).toBe(true);

    const controller = new AbortController();
    controller.abort();
    await expect(searchAuthorizedFiles(
      { source: "project", scopeId: workspace.slug, relativePath: "" },
      "visible",
      { signal: controller.signal },
    )).rejects.toHaveProperty("name", "AbortError");

    const outside = join(configDir, "outside-ref");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret", "utf-8");
    symlinkSync(outside, join(projectPath, "escape"), "junction");
    const escapedSearch = await searchAuthorizedFiles(
      { source: "project", scopeId: workspace.slug, relativePath: "" },
      "secret",
    );
    expect(escapedSearch.entries.map((entry) => entry.path)).not.toContain("escape/secret.txt");
    expect(() => resolveAuthorizedFileRef({ source: "project", scopeId: workspace.slug, relativePath: "escape/secret.txt" }))
      .toThrow("符号链接");
    expect(() => resolveAuthorizedFileRef({ source: "project", scopeId: workspace.slug, relativePath: "../secret.txt" }))
      .toThrow("FileRef");
  });

  test("session FileRefs are rooted at the file context and convert legacy thread paths once", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("session-ref", { projectPath });
    const thread = createAgentThread("session ref", undefined, workspace.id);
    const workdir = resolveAgentThreadWorkdir(thread.id);
    writeFileSync(join(workdir.filesRoot, "brief.md"), "brief", "utf-8");

    const converted = convertLegacyFileRef({
      recordKind: "thread-attachment",
      threadId: thread.id,
      workspaceSlug: workspace.slug,
      legacyRelativePath: "files/brief.md",
    });

    expect(converted).toEqual({ source: "session", scopeId: workdir.fileContextId, relativePath: "files/brief.md" });
    expect(resolveAuthorizedFileRef(converted).absolutePath).toBe(join(workdir.filesRoot, "brief.md"));
  });

  test("guarded project references revalidate the root fingerprint on every operation", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "guarded-project-old");
    const replacementPath = join(configDir, "guarded-project-new");
    mkdirSync(projectPath);
    mkdirSync(replacementPath);
    writeFileSync(join(projectPath, "bound.txt"), "old", "utf-8");
    writeFileSync(join(replacementPath, "bound.txt"), "new", "utf-8");
    const workspace = createAgentWorkspace("guarded project", { projectPath });
    const thread = createAgentThread("guarded project", undefined, workspace.id);
    const binding = createFileReferenceBinding(thread.id);
    const guardedRef = {
      ref: { source: "project" as const, scopeId: workspace.slug, relativePath: "bound.txt" },
      guard: {
        kind: "project" as const,
        workspaceSlug: workspace.slug,
        expectedProjectRootFingerprint: binding.projectRootFingerprint!,
        consumerThreadId: thread.id,
      },
    };

    expect(validateGuardedFileRef(guardedRef)).toMatchObject({ ok: true, entry: { name: "bound.txt" } });
    expect(readGuardedFileRef(guardedRef).content).toBe("old");

    rmSync(projectPath, { recursive: true, force: true });
    relocateUnavailableAgentWorkspace(workspace.id, replacementPath);
    expect(validateGuardedFileRef(guardedRef)).toMatchObject({ ok: false, code: "BINDING_CHANGED" });
    expect(() => readGuardedFileRef(guardedRef)).toThrow("BINDING_CHANGED");
  });

  test("a forked thread cannot consume the source thread session binding", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "guarded-session-project");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("guarded session", { projectPath });
    const sourceThread = createAgentThread("guarded source", undefined, workspace.id);
    const sourceWorkdir = resolveAgentThreadWorkdir(sourceThread.id);
    writeFileSync(join(sourceWorkdir.filesRoot, "brief.md"), "brief", "utf-8");
    const binding = createFileReferenceBinding(sourceThread.id);
    const fork = createAgentThread("guarded fork", undefined, workspace.id, sourceThread.id, undefined, { fileContextMode: "fork" });
    const guardedRef = {
      ref: { source: "session" as const, scopeId: binding.fileContextId, relativePath: "files/brief.md" },
      guard: {
        kind: "session" as const,
        consumerThreadId: fork.id,
        expectedFileContextId: binding.fileContextId,
      },
    };

    expect(validateGuardedFileRef(guardedRef)).toMatchObject({ ok: false, code: "BINDING_CHANGED" });
  });

  test("legacy thread conversion rejects an in-root junction that escapes the file context", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-legacy-escape");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("legacy escape", { projectPath });
    const thread = createAgentThread("legacy escape", undefined, workspace.id);
    const workdir = resolveAgentThreadWorkdir(thread.id);
    const outside = join(configDir, "outside-legacy-escape");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret", "utf-8");
    try {
      symlinkSync(outside, join(workdir.filesRoot, "escape"), "junction");
    } catch (error) {
      if (["EACCES", "ENOSYS", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }

    expect(() => convertLegacyFileRef({
      recordKind: "thread-attachment",
      threadId: thread.id,
      workspaceSlug: workspace.slug,
      legacyRelativePath: "files/escape/secret.txt",
    })).toThrow("符号链接");
  });

  test("authorized mutations reject the session root and moving a directory into itself", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-mutation-guards");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("mutation guards", { projectPath });
    const thread = createAgentThread("mutation guards", undefined, workspace.id);
    const workdir = resolveAgentThreadWorkdir(thread.id);
    mkdirSync(join(workdir.filesRoot, "parent", "child"), { recursive: true });
    const root = { source: "session", scopeId: workdir.fileContextId, relativePath: "" } as const;
    const files = { ...root, relativePath: "files" };
    const parent = { ...root, relativePath: "files/parent" };
    const child = { ...root, relativePath: "files/parent/child" };

    expect(() => renameAuthorizedFileRef(root, "renamed")).toThrow("根目录");
    expect(() => moveAuthorizedFileRef(root, files)).toThrow("根目录");
    expect(() => moveAuthorizedFileRef(parent, parent)).toThrow("自身");
    expect(() => moveAuthorizedFileRef(parent, child)).toThrow("自身");
    expect(existsSync(join(workdir.filesRoot, "parent", "child"))).toBeTrue();
  });
  test("旧版资源只读导出到项目且拒绝覆盖和符号链接", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("project", { projectPath });
    const resources = getWorkspaceResourcesPath(workspace.slug);
    writeFileSync(join(resources, "legacy.txt"), "legacy", "utf-8");

    const exported = exportLegacyResourceToProject(workspace.slug, "legacy.txt", "error");
    expect(existsSync(exported.path)).toBeTrue();
    expect(() => exportLegacyResourceToProject(workspace.slug, "legacy.txt", "error")).toThrow("未覆盖");

    const outside = join(configDir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret", "utf-8");
    symlinkSync(outside, join(resources, "outside-link"), "junction");
    expect(() => exportLegacyResourceToProject(workspace.slug, "outside-link", "error")).toThrow("符号链接");
  });

  test("应通过 threads/<threadId> 新目录结构解析 workspace slug", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-thread-root";
    const sessionId = "session-thread-root";
    getAgentSessionPath(workspaceSlug, sessionId);

    expect(resolveWorkspaceSlugBySessionId(sessionId)).toBe(workspaceSlug);
  });

  test("未绑定项目目录的线程附件仍应保存到 file context", () => {
    const configDir = createTempConfigDir();
    const workspace = createAgentWorkspace("unbound workspace");
    const thread = createAgentThread("attachment thread", undefined, workspace.id);

    const [saved] = saveFilesToAgentSession({
      workspaceSlug: workspace.slug,
      threadId: thread.id,
      clientSubmissionId: "submission-unbound",
      files: [{ filename: "image.png", data: Buffer.from("image").toString("base64") }]
    });

    const sessionDir = getAgentSessionPath(workspace.slug, thread.id);
    const legacyDir = join(configDir, "agent-workspaces", workspace.slug, "threads", thread.id);
    expect(sessionDir).toContain(join("agent-file-contexts", thread.id));
    expect(saved?.targetPath).toBe(join(sessionDir, "image.png"));
    expect(existsSync(join(sessionDir, "image.png"))).toBeTrue();
    expect(existsSync(join(legacyDir, "image.png"))).toBeFalse();
  });

  test("已迁移线程应自动恢复重新出现在旧目录中的附件", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "recovery-project");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("recovery workspace", { projectPath });
    const thread = createAgentThread("recovery thread", undefined, workspace.id);
    const sessionDir = getAgentSessionPath(workspace.slug, thread.id);
    const legacyDir = join(configDir, "agent-workspaces", workspace.slug, "threads", thread.id);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "image.png"), "image");

    expect(getAgentSessionPath(workspace.slug, thread.id)).toBe(sessionDir);
    expect(existsSync(join(sessionDir, "image.png"))).toBeTrue();
    expect(existsSync(legacyDir)).toBeFalse();
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

  test("新 composer 附件不应覆盖会话中的同名文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-unique-attachment";
    const sessionId = "session-unique-attachment";
    saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      files: [{ filename: "brief.md", data: Buffer.from("existing").toString("base64") }]
    });

    const [saved] = saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      clientSubmissionId: "submission-unique",
      files: [{ filename: "brief.md", data: Buffer.from("new").toString("base64") }]
    });

    expect(saved?.threadPath).toBe("brief (2).md");
    expect(existsSync(join(getAgentSessionPath(workspaceSlug, sessionId), "brief.md"))).toBeTrue();
    expect(existsSync(join(getAgentSessionPath(workspaceSlug, sessionId), "brief (2).md"))).toBeTrue();
  });

  test("批量附件 prepare 失败时应清理本次已复制的文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-partial-attachment";
    const sessionId = "session-partial-attachment";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);

    expect(() => saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      clientSubmissionId: "submission-partial",
      files: [
        { filename: "first.md", data: Buffer.from("first").toString("base64") },
        { filename: "missing.md" }
      ]
    })).toThrow("缺少文件内容");

    expect(existsSync(join(sessionDir, "first.md"))).toBeFalse();
    expect(existsSync(join(sessionDir, "missing.md"))).toBeFalse();
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

  test("工作区根目录文件管理应列出并读取 bootstrap 文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-root-files";

    saveFilesToWorkspaceRoot({
      workspaceSlug,
      files: [{ filename: "WORKSPACE.md", data: Buffer.from("# workspace").toString("base64") }]
    });
    saveFilesToWorkspace({
      workspaceSlug,
      files: [{ filename: "resource.md", data: Buffer.from("# resource").toString("base64") }]
    });

    const rootEntries = listWorkspaceRootDirectory(workspaceSlug);
    expect(rootEntries.some((entry) => entry.name === "WORKSPACE.md")).toBeTrue();
    expect(rootEntries.some((entry) => entry.name === "resources")).toBeTrue();
    expect(rootEntries.some((entry) => entry.name === "resource.md")).toBeFalse();
    expect(readWorkspaceRootPath(workspaceSlug, "WORKSPACE.md")).toEqual({
      content: "# workspace",
      truncated: false
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
