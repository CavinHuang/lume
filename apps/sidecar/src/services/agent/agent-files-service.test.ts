import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { getWorkspaceResourcesPath } from "../infra/config-paths";
import {
  convertLegacyFileRef,
  createFileReferenceBinding,
  getAgentSessionPath,
  listAgentDirectory,
  listProjectDirectory,
  listWorkspaceRootDirectory,
  listWorkspaceDirectory,
  moveAuthorizedFileRef,
  promoteFileRefToProject,
  readAuthorizedFileRef,
  readGuardedFileRef,
  readWorkspaceRootPath,
  renameAuthorizedFileRef,
  resolveAuthorizedFileRef,
  resolveAuthorizedBrowserUploadPaths,
  validateGuardedFileRef,
  resolveThreadAttachmentPath,
  resolveWorkspaceSlugBySessionId,
  saveFilesToAgentSession,
  saveFilesToAgentSessionStreamed,
  saveFilesToWorkspaceRoot,
  saveFilesToWorkspace,
  searchAuthorizedFiles,
  statAuthorizedFileRef,
  writeAuthorizedFileRef,
  watchAuthorizedFileRef,
  unwatchAuthorizedFileRef,
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(join(global.dailyDir, "watch.md"), "changed", "utf-8");
    const result = await Promise.race([
      changed.then(() => "changed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ]);
    expect(result).toBe("changed");
  }, 15_000);

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

  test("browser uploads resolve only current thread project and session files", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "browser-upload-project");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("browser-upload", { projectPath });
    const thread = createAgentThread("browser upload", undefined, workspace.id);
    const workdir = resolveAgentThreadWorkdir(thread.id);
    const projectFile = join(projectPath, "project.txt");
    const sessionFile = join(workdir.filesRoot, "session.txt");
    writeFileSync(projectFile, "project", "utf8");
    writeFileSync(sessionFile, "session", "utf8");
    const encodedRef = `lume-file-ref:${Buffer.from(JSON.stringify({
      source: "session",
      scopeId: workdir.fileContextId,
      relativePath: "files/session.txt",
    })).toString("base64url")}`;

    expect(resolveAuthorizedBrowserUploadPaths(thread.id, [projectFile, encodedRef])).toEqual([projectFile, sessionFile]);
    const outside = join(configDir, "outside-upload.txt");
    writeFileSync(outside, "outside", "utf8");
    expect(() => resolveAuthorizedBrowserUploadPaths(thread.id, [outside])).toThrow("不属于当前任务");
  });

  test("reads and atomically writes editable FileRefs with encoding and mtime conflict protection", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-edit");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("project-edit", { projectPath });
    const ref = { source: "project" as const, scopeId: workspace.slug, relativePath: "sample.txt" };
    writeFileSync(join(projectPath, "sample.txt"), Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("one\r\ntwo\r\n", "utf16le"),
    ]));

    const document = readAuthorizedFileRef(ref);
    expect(document).toMatchObject({
      kind: "text",
      content: "one\r\ntwo\r\n",
      encoding: "utf-16le",
      bom: true,
      lineEnding: "crlf",
      editable: true,
    });
    if (document.kind !== "text") throw new Error("expected text document");

    const saved = writeAuthorizedFileRef({
      ref,
      content: "three\nfour\n",
      expectedMtimeMs: document.mtimeMs,
    });
    expect(saved.outcome).toBe("saved");
    expect(readFileSync(join(projectPath, "sample.txt")).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    const current = readAuthorizedFileRef(ref);
    expect(current).toMatchObject({ kind: "text", content: "three\r\nfour\r\n" });
    expect(() => writeAuthorizedFileRef({
      ref,
      content: "x".repeat(5 * 1024 * 1024 + 1),
      expectedMtimeMs: current.mtimeMs,
    })).toThrow("超过 10 MB");

    expect(writeAuthorizedFileRef({ ref, content: "stale", expectedMtimeMs: 0 }).outcome).toBe("conflict");
    expect(() => writeAuthorizedFileRef({
      ref: { source: "memory", scopeId: "global", relativePath: "MEMORY.md" },
      content: "forbidden",
      expectedMtimeMs: 0,
    })).toThrow("只读");
  });

  test("deduplicates FileRef watchers and emits external file changes", async () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-watch");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("project-watch", { projectPath });
    const ref = { source: "project" as const, scopeId: workspace.slug, relativePath: "watch.txt" };
    writeFileSync(join(projectPath, "watch.txt"), "before", "utf-8");
    let resolveChanged!: () => void;
    const changed = new Promise<void>((resolve) => { resolveChanged = resolve; });
    const first = watchAuthorizedFileRef(ref, (method) => {
      if (method === "agent:file-ref-changed") resolveChanged();
    });
    const second = watchAuthorizedFileRef(ref, () => undefined);
    writeFileSync(join(projectPath, "watch.txt"), "after", "utf-8");
    expect(await Promise.race([
      changed.then(() => "changed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
    ])).toBe("changed");
    expect(unwatchAuthorizedFileRef(first.watchId)).toEqual({ ok: true });
    expect(unwatchAuthorizedFileRef(second.watchId)).toEqual({ ok: true });
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
      expectedKind: "file" as const,
      ref: { source: "project" as const, scopeId: workspace.slug, relativePath: "bound.txt" },
      guard: {
        kind: "project" as const,
        workspaceSlug: workspace.slug,
        expectedProjectRootFingerprint: binding.projectRootFingerprint!,
        consumerThreadId: thread.id,
      },
    };

    expect(validateGuardedFileRef(guardedRef)).toMatchObject({ ok: true, entry: { name: "bound.txt" } });
    expect(validateGuardedFileRef({ ...guardedRef, expectedKind: "directory" })).toMatchObject({ ok: false, code: "KIND_MISMATCH" });
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
      expectedKind: "file" as const,
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

  test("桌面附件应通过流复制并生成稳定 hash", async () => {
    createTempConfigDir();
    const sourceRoot = mkdtempSync(join(tmpdir(), "lume-agent-stream-src-"));
    createdDirs.push(sourceRoot);
    const sourcePath = join(sourceRoot, "large.bin");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
    writeFileSync(sourcePath, bytes);

    const [saved] = await saveFilesToAgentSessionStreamed({
      workspaceSlug: "workspace-stream",
      threadId: "session-stream",
      clientSubmissionId: "submission-stream",
      files: [{
        id: "attachment-stream",
        filename: "large.bin",
        mediaType: "application/octet-stream",
        size: bytes.byteLength,
        sourcePath
      }]
    });

    expect(saved).toMatchObject({
      id: "attachment-stream",
      size: bytes.byteLength,
      contentHash: createHash("sha256").update(bytes).digest("hex")
    });
    expect(existsSync(saved!.targetPath)).toBeTrue();
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

  test("图片声明必须与文件头一致并返回可信元数据", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-image-magic";
    const sessionId = "session-image-magic";

    expect(() => saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      clientSubmissionId: "submission-image-invalid",
      files: [{
        id: "attachment-invalid",
        filename: "fake.png",
        mediaType: "image/png",
        size: 4,
        data: Buffer.from("text").toString("base64")
      }]
    })).toThrow("图片内容与类型不匹配");

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const [saved] = saveFilesToAgentSession({
      workspaceSlug,
      threadId: sessionId,
      clientSubmissionId: "submission-image-valid",
      files: [{
        id: "attachment-valid",
        filename: "valid.png",
        mediaType: "image/png",
        size: pngBytes.byteLength,
        data: pngBytes.toString("base64")
      }]
    });

    expect(saved).toMatchObject({
      id: "attachment-valid",
      mediaType: "image/png",
      size: pngBytes.byteLength
    });
    expect(saved?.contentHash).toHaveLength(64);
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

});

describe("promoteFileRefToProject", () => {
  test("session 文件复制到项目根且源保留", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-promote");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("promote", { projectPath });
    const thread = createAgentThread("promote thread", undefined, workspace.id);
    const workdir = resolveAgentThreadWorkdir(thread.id);
    writeFileSync(join(workdir.filesRoot, "brief.md"), "brief", "utf-8");
    const ref = { source: "session" as const, scopeId: workdir.fileContextId, relativePath: "files/brief.md" };

    const promoted = promoteFileRefToProject(ref, workspace.slug);

    expect(promoted.ok).toBeTrue();
    expect(basename(promoted.path)).toBe("brief.md");
    expect(existsSync(promoted.path)).toBeTrue();
    expect(readFileSync(promoted.path, "utf-8")).toBe("brief");
    expect(existsSync(join(workdir.filesRoot, "brief.md"))).toBeTrue();
  });

  test("memory 与 legacy 条目可晋升且源保留", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-promote-multi");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("promote multi", { projectPath });
    const global = getMemoryV2ScopePaths({ scope: "global" });
    writeFileSync(global.memoryMd, "# memory", "utf-8");
    const resources = getWorkspaceResourcesPath(workspace.slug);
    writeFileSync(join(resources, "legacy.txt"), "legacy", "utf-8");

    const memory = promoteFileRefToProject(
      { source: "memory", scopeId: "global", relativePath: "MEMORY.md" },
      workspace.slug
    );
    const legacy = promoteFileRefToProject(
      { source: "legacy", scopeId: workspace.slug, relativePath: "legacy.txt" },
      workspace.slug
    );

    expect(existsSync(memory.path)).toBeTrue();
    expect(existsSync(legacy.path)).toBeTrue();
    expect(readFileSync(memory.path, "utf-8")).toBe("# memory");
    expect(readFileSync(legacy.path, "utf-8")).toBe("legacy");
    expect(existsSync(global.memoryMd)).toBeTrue();
    expect(existsSync(join(resources, "legacy.txt"))).toBeTrue();
  });

  test("空 relativePath（scope 根）拒绝晋升", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-promote-root");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("promote root", { projectPath });
    const thread = createAgentThread("promote root thread", undefined, workspace.id);
    const workdir = resolveAgentThreadWorkdir(thread.id);
    writeFileSync(join(workdir.filesRoot, "a.md"), "x", "utf-8");

    for (const relativePath of ["", ".", "./"]) {
      expect(() => promoteFileRefToProject(
        { source: "session" as const, scopeId: workdir.fileContextId, relativePath },
        workspace.slug
      )).toThrow("不能晋升来源根目录");
    }
    expect(readdirSync(projectPath).some((name) => name.startsWith(".lume-promote"))).toBeFalse();
  });

  test("project 自身 ref 拒绝晋升", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-promote-self");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("promote self", { projectPath });

    expect(() => promoteFileRefToProject(
      { source: "project", scopeId: workspace.slug, relativePath: "any.md" },
      workspace.slug
    )).toThrow("项目");
  });

  test("同名冲突报错且不覆盖既有内容", () => {
    const configDir = createTempConfigDir();
    const projectPath = join(configDir, "project-promote-conflict");
    mkdirSync(projectPath);
    const workspace = createAgentWorkspace("promote conflict", { projectPath });
    writeFileSync(join(projectPath, "legacy.txt"), "existing", "utf-8");
    const resources = getWorkspaceResourcesPath(workspace.slug);
    writeFileSync(join(resources, "legacy.txt"), "legacy", "utf-8");

    expect(() => promoteFileRefToProject(
      { source: "legacy", scopeId: workspace.slug, relativePath: "legacy.txt" },
      workspace.slug
    )).toThrow("已存在同名");
    expect(readFileSync(join(projectPath, "legacy.txt"), "utf-8")).toBe("existing");
  });

  test("目标 workspace 未绑定项目目录时报错", () => {
    createTempConfigDir();
    const workspace = createAgentWorkspace("promote unbound");
    const resources = getWorkspaceResourcesPath(workspace.slug);
    writeFileSync(join(resources, "legacy.txt"), "legacy", "utf-8");

    expect(() => promoteFileRefToProject(
      { source: "legacy", scopeId: workspace.slug, relativePath: "legacy.txt" },
      workspace.slug
    )).toThrow("项目尚未绑定本地目录");
  });
});
