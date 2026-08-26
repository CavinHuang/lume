import {
  cpSync,
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  type Dirent,
  renameSync,
  readFileSync,
  readSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  chmodSync,
  watch,
  type FSWatcher,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { lstat, readdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createLogger } from "../infra/logger";
import type {
  AttachWorkspaceResourceToThreadInput,
  AttachWorkspaceResourceToThreadResult,
  AgentCopyFolderInput,
  AgentSaveFilesInput,
  AgentSavedFile,
  ExternalAttachmentMeta,
  FileEntry,
  FileRef,
  FileRefChangedEvent,
  FileSearchResult,
  WorkspaceCopyFolderInput,
  WorkspaceSaveFilesInput,
} from "@lume/shared";
import { AGENT_ATTACHMENT_LIMITS } from "@lume/shared";
import {
  getAgentThreadRootPath,
  getAgentWorkspacePath,
  getAgentWorkspacesDir,
} from "../infra/config-paths";
import { getMemoryV2ScopePaths } from "../memory-v2/paths";

const log = createLogger("agent-files-service");
import { listMemorySourceFilesForScope } from "../memory-v2/source-files";
import {
  resolveAgentThreadLumeWorkDir,
  resolveAgentThreadWorkdir,
} from "./agent-workdir-resolver";
import { getAgentThreadMeta } from "./agent-thread-manager";
import { getAgentWorkspaceBySlug } from "./agent-workspace-manager";
import {
  assertAttachmentMetadataHealthy,
  deleteAttachmentMeta,
  getAttachmentMeta,
  moveAttachmentMeta,
  readThreadAttachmentMeta,
  readWorkspaceAttachmentMeta,
  upsertAttachmentMeta,
  type AttachmentScope,
  type ThreadAttachmentScope,
} from "./agent-attachment-meta-service";
import {
  isWithin,
  resolveWorkspaceResourcesDir,
  validatePathSegment,
} from "./agent-file-paths";
import {
  authorizedFileRefWatchKey,
  enrichEntryWithFileRef,
  fileWatchGroups,
  fileWatchKeysById,
  markAuthorizedFileRefSelfWrite,
  normalizeAuthorizedRelativePath,
  readFileRefDocument,
  resolveAuthorizedFileRef,
  resolveFileRefRoot,
  selfWrites,
  GuardedFileRefError,
  type FileRefNotificationEmitter,
  type FileWatchGroup,
} from "./agent-file-ref";

export * from "./agent-file-ref";

function resolveSessionDir(
  workspaceSlug: string | undefined,
  sessionId: string,
): string {
  validatePathSegment(sessionId, "sessionId");
  try {
    return resolveAgentThreadLumeWorkDir(sessionId);
  } catch (error) {
    if (!workspaceSlug) throw error;
    validatePathSegment(workspaceSlug, "workspaceSlug");
    return getAgentThreadRootPath(workspaceSlug, sessionId);
  }
}

function resolveWorkspaceRootDir(workspaceSlug: string): string {
  validatePathSegment(workspaceSlug, "workspaceSlug");
  return getAgentWorkspacePath(workspaceSlug);
}

function getThreadAttachmentScope(
  workspaceSlug: string | undefined,
  sessionId: string,
): ThreadAttachmentScope {
  const thread = getAgentThreadMeta(sessionId);
  if (thread) {
    const fileContextId = thread.fileContextId?.trim() || thread.id;
    resolveAgentThreadLumeWorkDir(sessionId);
    return {
      kind: "thread",
      workspaceSlug: workspaceSlug ?? fileContextId,
      threadId: sessionId,
      fileContextId,
    };
  }
  if (!workspaceSlug) throw new Error(`Agent 线程不存在: ${sessionId}`);
  return { kind: "thread", workspaceSlug, threadId: sessionId };
}

function resolveExistingProjectTarget(
  workspaceSlug: string,
  targetPath?: string,
): string {
  validatePathSegment(workspaceSlug, "workspaceSlug");
  const workspace = getAgentWorkspaceBySlug(workspaceSlug);
  if (!workspace?.projectPath) {
    throw new Error("项目尚未绑定本地目录");
  }
  const projectRoot = realpathSync(workspace.projectPath);
  const candidate = resolveSafePathWithin(
    projectRoot,
    targetPath,
    "目标路径超出项目目录",
  );
  if (!existsSync(candidate)) {
    throw new Error("目标不存在");
  }
  const realTarget = realpathSync(candidate);
  if (!isWithin(projectRoot, realTarget)) {
    throw new Error("目标路径超出项目目录");
  }
  return realTarget;
}

function getWorkspaceAttachmentScope(workspaceSlug: string): AttachmentScope {
  return { kind: "workspace", workspaceSlug };
}

function isExternalSourcePath(
  workspaceSlug: string | undefined,
  sourcePath: string,
  threadId?: string,
): boolean {
  if (threadId) {
    return !isWithin(
      resolveSessionDir(workspaceSlug, threadId),
      resolve(sourcePath),
    );
  }
  if (!workspaceSlug) return true;
  const workspaceRoot = resolve(getAgentWorkspacePath(workspaceSlug));
  return !isWithin(workspaceRoot, resolve(sourcePath));
}

function enrichEntriesWithAttachmentMeta(
  entries: FileEntry[],
  rootPath: string,
  metadataByRelativePath: Record<string, ExternalAttachmentMeta>,
): FileEntry[] {
  return entries.map((entry) => {
    const relPath = relative(rootPath, entry.path).split(sep).join("/");
    const externalAttachment = metadataByRelativePath[relPath];
    return externalAttachment ? { ...entry, externalAttachment } : entry;
  });
}

export function resolveWorkspaceSlugBySessionId(
  sessionId: string,
): string | null {
  validatePathSegment(sessionId, "sessionId");
  const workspacesDir = getAgentWorkspacesDir();
  if (!existsSync(workspacesDir)) return null;
  for (const entry of readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const threadRootCandidate = join(
      workspacesDir,
      entry.name,
      "threads",
      sessionId,
    );
    if (existsSync(threadRootCandidate)) {
      return entry.name;
    }
    const legacyCandidate = join(workspacesDir, entry.name, sessionId);
    if (!existsSync(legacyCandidate)) continue;
    return entry.name;
  }
  return null;
}

export const resolveWorkspaceSlugByThreadId = resolveWorkspaceSlugBySessionId;

function resolveSafeTarget(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath?: string,
): string {
  const sessionDir = resolveSessionDir(workspaceSlug, sessionId);
  return resolveSafePathWithin(
    sessionDir,
    targetPath,
    "目标路径超出线程工作目录",
  );
}

function resolveSafePath(
  basePath: string,
  targetPath?: string,
  errorMessage = "目标路径超出允许范围",
): string {
  return resolveSafePathWithin(basePath, targetPath, errorMessage);
}

function resolveSafePathWithin(
  basePath: string,
  targetPath?: string,
  errorMessage = "目标路径超出允许范围",
): string {
  const base = resolve(basePath);
  if (!targetPath || targetPath.trim().length === 0) return base;
  const trimmed = targetPath.trim();
  const resolved = resolve(isAbsolute(trimmed) ? trimmed : join(base, trimmed));
  if (!isWithin(base, resolved)) {
    throw new Error(errorMessage);
  }
  return resolved;
}

export function watchAuthorizedFileRef(
  ref: FileRef,
  emit: FileRefNotificationEmitter,
): { watchId: string } {
  const resolved = resolveAuthorizedFileRef(ref);
  if (!statSync(resolved.absolutePath).isFile())
    throw new Error("FileRef 目标不是文件");
  const key = authorizedFileRefWatchKey(ref);
  let group = fileWatchGroups.get(key);
  if (!group) {
    const subscriptions = new Map<string, FileRefNotificationEmitter>();
    const watcher = watch(
      dirname(resolved.absolutePath),
      (eventType, filename) => {
        if (
          filename &&
          String(filename).toLowerCase() !==
            basename(resolved.absolutePath).toLowerCase()
        )
          return;
        const currentGroup = fileWatchGroups.get(key);
        if (!currentGroup) return;
        let change: FileRefChangedEvent["change"] = "deleted";
        let mtimeMs: number | undefined;
        let size: number | undefined;
        try {
          const metadata = statSync(currentGroup.absolutePath);
          mtimeMs = metadata.mtimeMs;
          size = metadata.size;
          change = eventType === "rename" ? "renamed" : "changed";
        } catch {
          // The file may disappear between the directory event and stat.
        }
        const selfWrite = selfWrites.get(key);
        if (
          selfWrite &&
          selfWrite.until >= Date.now() &&
          mtimeMs === selfWrite.mtimeMs &&
          size === selfWrite.size
        ) {
          return;
        }
        selfWrites.delete(key);
        for (const [watchId, notify] of currentGroup.subscriptions) {
          notify("agent:file-ref-changed", {
            watchId,
            ref: currentGroup.ref,
            change,
            ...(mtimeMs === undefined ? {} : { mtimeMs }),
          } satisfies FileRefChangedEvent);
        }
      },
    );
    group = {
      watcher,
      ref: resolved.ref,
      absolutePath: resolved.absolutePath,
      subscriptions,
    };
    fileWatchGroups.set(key, group);
  }
  const watchId = randomUUID();
  group.subscriptions.set(watchId, emit);
  fileWatchKeysById.set(watchId, key);
  return { watchId };
}

export function unwatchAuthorizedFileRef(watchId: string): { ok: true } {
  const key = fileWatchKeysById.get(watchId);
  if (!key) return { ok: true };
  fileWatchKeysById.delete(watchId);
  const group = fileWatchGroups.get(key);
  group?.subscriptions.delete(watchId);
  if (group && group.subscriptions.size === 0) {
    group.watcher.close();
    fileWatchGroups.delete(key);
    selfWrites.delete(key);
  }
  return { ok: true };
}

export function renameAuthorizedFileRef(
  ref: FileRef,
  newName: string,
): { ok: true; ref: FileRef } {
  assertWritableFileRef(ref);
  const resolved = resolveAuthorizedFileRef(ref);
  if (!resolved.relativePath) throw new Error("不能重命名 FileRef 根目录");
  const target = join(dirname(resolved.absolutePath), validateNewName(newName));
  if (existsSync(target)) throw new Error("目标路径已存在同名文件");
  renameSync(resolved.absolutePath, target);
  return {
    ok: true,
    ref: {
      ...ref,
      relativePath: relative(resolved.rootPath, target).split(sep).join("/"),
    },
  };
}

export function moveAuthorizedFileRef(
  ref: FileRef,
  targetDirectory: FileRef,
): { ok: true; ref: FileRef; warning?: string } {
  assertWritableFileRef(ref);
  assertWritableFileRef(targetDirectory);
  if (ref.scopeId !== targetDirectory.scopeId)
    throw new Error("不能跨 FileRef scope 移动");
  const source = resolveAuthorizedFileRef(ref);
  const directory = resolveAuthorizedFileRef(targetDirectory);
  if (!source.relativePath) throw new Error("不能移动 FileRef 根目录");
  if (!statSync(directory.absolutePath).isDirectory())
    throw new Error("目标目录不存在");
  if (
    statSync(source.absolutePath).isDirectory() &&
    isWithin(source.absolutePath, directory.absolutePath)
  ) {
    throw new Error("不能将目录移动到自身或其子目录");
  }
  const target = join(directory.absolutePath, basename(source.absolutePath));
  if (existsSync(target)) throw new Error("目标路径已存在同名文件");
  const moveWarning = movePathWithFallback(source.absolutePath, target);
  return {
    ok: true,
    ref: {
      ...ref,
      relativePath: relative(source.rootPath, target).split(sep).join("/"),
    },
    ...(moveWarning ? { warning: moveWarning } : {}),
  };
}

export function deleteAuthorizedFileRef(ref: FileRef): { ok: true } {
  assertWritableFileRef(ref);
  const resolved = resolveAuthorizedFileRef(ref);
  if (!resolved.relativePath) throw new Error("不能删除 FileRef 根目录");
  rmSync(resolved.absolutePath, {
    recursive: statSync(resolved.absolutePath).isDirectory(),
    force: true,
  });
  return { ok: true };
}

export function convertLegacyFileRef(
  input:
    | {
        recordKind: "thread-attachment";
        threadId: string;
        workspaceSlug?: string;
        legacyRelativePath: string;
      }
    | {
        recordKind: "memory-source";
        workspaceSlug: string;
        legacyRelativePath: string;
      },
): FileRef {
  if (input.recordKind === "thread-attachment") {
    const root = resolveSessionDir(input.workspaceSlug, input.threadId);
    const target = resolveSafePathWithin(
      root,
      input.legacyRelativePath,
      "旧附件路径超出线程目录",
    );
    if (!existsSync(target)) throw new Error("旧附件不存在");
    const context = resolveAgentThreadWorkdir(input.threadId);
    const candidate: FileRef = {
      source: "session",
      scopeId: context.fileContextId,
      relativePath: relative(resolve(root), resolve(target))
        .split(sep)
        .join("/"),
    };
    return resolveAuthorizedFileRef(candidate).ref;
  }
  const target = realpathSync(input.legacyRelativePath);
  const workspaceRoot = realpathSync(
    getMemoryV2ScopePaths({
      scope: "workspace",
      workspaceSlug: input.workspaceSlug,
    }).root,
  );
  const globalRoot = realpathSync(
    getMemoryV2ScopePaths({ scope: "global" }).root,
  );
  if (isWithin(workspaceRoot, target)) {
    return {
      source: "memory",
      scopeId: `workspace:${input.workspaceSlug}`,
      relativePath: relative(workspaceRoot, target).split(sep).join("/"),
    };
  }
  if (isWithin(globalRoot, target)) {
    return {
      source: "memory",
      scopeId: "global",
      relativePath: relative(globalRoot, target).split(sep).join("/"),
    };
  }
  throw new Error("旧记忆来源超出授权目录");
}

function assertWritableFileRef(ref: FileRef): void {
  if (ref.source !== "session") throw new Error("该文件来源为只读");
}

function validateNewName(newName: string): string {
  const trimmed = newName.trim();
  if (!trimmed) {
    throw new Error("新名称不能为空");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("新名称非法");
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("新名称不能包含路径分隔符");
  }
  return trimmed;
}

/** 同步短退避（毫秒级），避免为瞬时占用直接走 O(总字节) 的同步拷贝阻塞 RPC 循环。 */
function sleepSync(ms: number): void {
  // Node 主线程允许 Atomics.wait；环境异常时退化为不等（占用重试退化为直接降级拷贝）。
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // ignore
  }
}

// 移动/重命名最终失败会直达前端 toast，常见 errno 翻译成可行动的中文（#552 UX review round7）
const MOVE_ERRNO_MESSAGES: Record<string, string> = {
  EACCES: "没有操作权限，请检查文件权限或是否被其他程序占用",
  EPERM: "没有操作权限，请检查文件权限或是否被其他程序占用",
  ENOSPC: "磁盘空间不足，请清理后重试",
  ENOENT: "文件或目录不存在，可能已被移动或删除",
  EEXIST: "目标位置已存在同名文件",
  EISDIR: "目标是目录，无法完成该操作",
  ENOTDIR: "路径中包含非目录项",
  EMFILE: "系统打开的文件过多，请稍后重试",
};

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function translateMoveError(error: unknown): Error {
  const code = errnoOf(error);
  const hint = typeof code === "string" ? MOVE_ERRNO_MESSAGES[code] : undefined;
  if (!hint) return error instanceof Error ? error : new Error(String(error));
  return new Error(hint);
}

/**
 * 返回 undefined=干净完成；有值=移动成功但源副本清理失败（Windows 占用窗口），
 * 调用方必须把它透传到 RPC 结果供前端提示，否则用户会看到旧路径文件"复活"（#552 UX review round7）。
 */
function movePathWithFallback(sourcePath: string, targetPath: string): string | undefined {
  try {
    return movePathWithFallbackInner(sourcePath, targetPath);
  } catch (error) {
    throw translateMoveError(error);
  }
}

function movePathWithFallbackInner(sourcePath: string, targetPath: string): string | undefined {
  let firstErrorCode: string | undefined;
  try {
    renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    // EXDEV=跨设备（全平台降级）；EPERM/EBUSY 仅 Windows 走占用重试+降级——
    // POSIX 上二者多为永久语义（如 mount point rename 返回 EBUSY），降级拷贝后删源会清空挂载内容（#552 review round5）
    const code = errnoOf(error);
    const occupancyRetry = process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
    if (code !== "EXDEV" && !occupancyRetry) {
      throw error;
    }
    firstErrorCode = code;
  }
  // 占用类错误通常毫秒~秒级释放：先短退避重试 rename，命中即免去整棵拷贝（仅 EXDEV 直接降级）
  if (firstErrorCode !== "EXDEV") {
    for (const delayMs of [50, 150]) {
      sleepSync(delayMs);
      try {
        renameSync(sourcePath, targetPath);
        log.info("文件移动占用重试成功", { code: firstErrorCode, sourcePath, targetPath, retriedAfterMs: delayMs });
        return;
      } catch (error) {
        const code = errnoOf(error);
        if (code !== "EPERM" && code !== "EBUSY") {
          throw error;
        }
      }
    }
  }
  log.info("文件移动降级为拷贝+删除", { code: firstErrorCode, sourcePath, targetPath });
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    rmSync(targetPath, { recursive: true, force: true });
    cpSync(sourcePath, targetPath, { recursive: true, preserveTimestamps: true });
    try {
      removeSourceAfterCopy(sourcePath);
    } catch (error) {
      // 源清理失败不回滚：此时 target 已是完整副本，删掉它才是数据丢失；保留双份由用户重试清理。
      // 必须留痕并透传 warning——RPC 仍返回 ok，不提示则旧路径"复活"的源副本无从解释（#552 review round4）
      const detail = error instanceof Error ? error.message : String(error);
      log.warn("移动降级拷贝后源清理失败，已保留完整目标副本与残留源", {
        sourcePath,
        targetPath,
        error: detail,
      });
      return `移动已完成，但旧位置文件因被占用未能清理（${detail}），请稍后手动删除`;
    }
  } catch (error) {
    // 清场自身失败不得顶替原始错误
    try {
      rmSync(targetPath, { recursive: true, force: true });
    } catch {
      // 残留半截 target 可接受，优先暴露拷贝根因
    }
    throw error;
  }
  return undefined;
}

/**
 * 拷贝完成后的源清理。Windows/Electron 的 rmSync 不清 FILE_ATTRIBUTE_READONLY
 * （.git/objects、npm 包内文件普遍只读，force 只压 ENOENT），失败时先递归清只读属性再重试一次。
 */
function removeSourceAfterCopy(sourcePath: string): void {
  try {
    rmSync(sourcePath, { recursive: true, force: true });
    return;
  } catch (firstError) {
    if (process.platform !== "win32") throw firstError;
    try {
      clearReadOnlyRecursive(sourcePath);
      rmSync(sourcePath, { recursive: true, force: true });
      log.info("源清理经只读属性清除后成功", { sourcePath });
    } catch {
      throw firstError; // 重试仍失败：保留原始错误（占用/权限），由调用方走 warning 路径
    }
  }
}

function clearReadOnlyRecursive(root: string): void {
  // lstat 不跟随链接：junction/symlink 指向源树之外（全局 store、用户目录）时
  // chmod 会越出授权范围，成环还会无界递归——链接条目直接跳过（rmSync 本身也不跟随）
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(root)) {
      clearReadOnlyRecursive(join(root, entry));
    }
  }
  try {
    chmodSync(root, stat.isDirectory() ? 0o777 : 0o666);
  } catch {
    // 单个条目清属性失败不阻断整体重试
  }
}

export function getAgentSessionPath(
  workspaceSlug: string | undefined,
  sessionId: string,
): string {
  return resolveSessionDir(workspaceSlug, sessionId);
}

export const getAgentThreadPath = getAgentSessionPath;

export function toThreadRelativePath(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
): string {
  const sessionDir = resolveSessionDir(workspaceSlug, sessionId);
  const resolved = resolve(targetPath);
  if (!isWithin(sessionDir, resolved)) {
    throw new Error("附件路径不在当前线程目录内");
  }
  return relative(sessionDir, resolved).split(sep).join("/");
}

export function resolveThreadAttachmentPath(
  workspaceSlug: string | undefined,
  sessionId: string,
  threadPath: string,
): string {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, threadPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error("附件文件不存在");
  }
  return resolved;
}

export function getWorkspaceResourcesDirectory(workspaceSlug: string): string {
  return resolveWorkspaceResourcesDir(workspaceSlug);
}

export function listAgentDirectory(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath?: string,
): FileEntry[] {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  if (!existsSync(resolved)) return [];
  const sessionRoot = resolveSessionDir(workspaceSlug, sessionId);
  const threadScope = getThreadAttachmentScope(workspaceSlug, sessionId);
  const attachmentMeta = readThreadAttachmentMeta(
    threadScope.workspaceSlug,
    sessionId,
    threadScope.fileContextId,
  );

  const items = readdirSync(resolved, { withFileTypes: true }).map((entry) => {
    const fullPath = join(resolved, entry.name);
    return {
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory(),
    } satisfies FileEntry;
  });

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });

  return enrichEntriesWithAttachmentMeta(
    items,
    sessionRoot,
    attachmentMeta,
  ).map((entry) =>
    enrichEntryWithFileRef(
      entry,
      sessionRoot,
      "session",
      threadScope.fileContextId ?? sessionId,
    ),
  );
}

export function listWorkspaceDirectory(
  workspaceSlug: string,
  targetPath?: string,
): FileEntry[] {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(
    resourcesDir,
    targetPath,
    "目标路径超出工作区共享目录",
  );
  if (!existsSync(resolved)) return [];
  const attachmentMeta = readWorkspaceAttachmentMeta(workspaceSlug);

  const items = readdirSync(resolved, { withFileTypes: true }).map((entry) => {
    const fullPath = join(resolved, entry.name);
    return {
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory(),
    } satisfies FileEntry;
  });

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });

  return enrichEntriesWithAttachmentMeta(
    items,
    resourcesDir,
    attachmentMeta,
  ).map((entry) =>
    enrichEntryWithFileRef(entry, resourcesDir, "legacy", workspaceSlug),
  );
}

export function listProjectDirectory(
  workspaceSlug: string,
  targetPath?: string,
): FileEntry[] {
  const resolved = resolveExistingProjectTarget(workspaceSlug, targetPath);
  if (!statSync(resolved).isDirectory()) {
    throw new Error("目标不是目录");
  }
  const items = readdirSync(resolved, { withFileTypes: true }).map(
    (entry) =>
      ({
        name: entry.name,
        path: join(resolved, entry.name),
        isDirectory: entry.isDirectory(),
      }) satisfies FileEntry,
  );
  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });
  const projectRoot = resolveExistingProjectTarget(workspaceSlug);
  return items.map((entry) =>
    enrichEntryWithFileRef(entry, projectRoot, "project", workspaceSlug),
  );
}

function assertLegacyExportSourceSafe(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error("旧版资源导出不允许符号链接或 junction");
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    assertLegacyExportSourceSafe(join(path, entry));
  }
}

export function exportLegacyResourceToProject(
  workspaceSlug: string,
  targetPath: string,
  conflict: "error",
): { ok: true; path: string; } {
  if (conflict !== "error") {
    throw new Error("旧版资源导出必须显式使用不覆盖策略");
  }
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const lexicalSource = resolveSafePathWithin(
    resourcesDir,
    targetPath,
    "源路径超出旧版资源目录",
  );
  if (!existsSync(lexicalSource)) throw new Error("旧版资源不存在");
  assertLegacyExportSourceSafe(lexicalSource);
  const source = realpathSync(lexicalSource);
  if (!isWithin(realpathSync(resourcesDir), source))
    throw new Error("源路径超出旧版资源目录");

  const projectRoot = resolveExistingProjectTarget(workspaceSlug);
  const destination = join(projectRoot, basename(source));
  if (existsSync(destination)) {
    throw new Error("项目目录已存在同名文件，未覆盖任何内容");
  }
  const staging = join(projectRoot, `.lume-export-${randomUUID()}`);
  try {
    cpSync(source, staging, {
      recursive: statSync(source).isDirectory(),
      errorOnExist: true,
      filter: (sourcePath) => {
        assertLegacyExportSourceSafe(sourcePath);
        return true;
      },
    });
    if (!isWithin(projectRoot, realpathSync(staging))) {
      throw new Error("导出目标超出项目目录");
    }
    renameSync(staging, destination);
    return { ok: true, path: destination };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** 复制式晋升：session/memory/legacy → project 根，源保留，同名报错。 */
export function promoteFileRefToProject(
  ref: FileRef,
  workspaceSlug: string,
): { ok: true; path: string; } {
  if (ref.source === "project") throw new Error("项目文件无需晋升");
  const rootPath = resolveFileRefRoot(ref);
  const lexicalSource = resolveSafePathWithin(
    rootPath,
    ref.relativePath,
    "源路径超出来源目录",
  );
  // IPC 边界防御：schema 的 relativePath 是裸 z.string()，空串/"." 会被 resolveSafePathWithin
  // 解析回 scope 根——禁止晋升整个来源根目录（否则 .context 内部元数据会被复制进项目）
  if (lexicalSource === resolve(rootPath))
    throw new Error("不能晋升来源根目录");
  if (!existsSync(lexicalSource)) throw new Error("源文件不存在");
  assertLegacyExportSourceSafe(lexicalSource);
  const source = realpathSync(lexicalSource);
  if (!isWithin(realpathSync(rootPath), source))
    throw new Error("源路径超出来源目录");

  const projectRoot = resolveExistingProjectTarget(workspaceSlug);
  const destination = join(projectRoot, basename(source));
  if (existsSync(destination))
    throw new Error("项目目录已存在同名文件，未覆盖任何内容");
  const staging = join(projectRoot, `.lume-promote-${randomUUID()}`);
  try {
    cpSync(source, staging, {
      recursive: statSync(source).isDirectory(),
      errorOnExist: true,
      filter: (sourcePath) => {
        assertLegacyExportSourceSafe(sourcePath);
        return true;
      },
    });
    if (!isWithin(projectRoot, realpathSync(staging)))
      throw new Error("晋升目标超出项目目录");
    renameSync(staging, destination);
    return { ok: true, path: destination };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
export function listWorkspaceRootDirectory(
  workspaceSlug: string,
  targetPath?: string,
): FileEntry[] {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(
    workspaceRoot,
    targetPath,
    "目标路径超出工作区根目录",
  );
  if (!existsSync(resolved)) return [];

  const items = readdirSync(resolved, { withFileTypes: true }).map((entry) => {
    const fullPath = join(resolved, entry.name);
    return {
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory(),
    } satisfies FileEntry;
  });

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });

  return items;
}

export function deleteAgentFile(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
): { ok: true } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  const rootPath = resolveSessionDir(workspaceSlug, sessionId);
  if (resolve(resolved) === resolve(rootPath)) {
    throw new Error("不能删除线程根目录");
  }
  if (!existsSync(resolved)) return { ok: true };

  assertAttachmentMetadataHealthy(
    getThreadAttachmentScope(workspaceSlug, sessionId),
  );
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    rmSync(resolved, { recursive: true, force: true });
  } else {
    rmSync(resolved, { force: true });
  }
  deleteAttachmentMeta(
    getThreadAttachmentScope(workspaceSlug, sessionId),
    resolved,
  );
  return { ok: true };
}

export function deleteWorkspaceFile(
  workspaceSlug: string,
  targetPath: string,
): { ok: true } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(
    resourcesDir,
    targetPath,
    "目标路径超出工作区共享目录",
  );
  if (resolve(resolved) === resolve(resourcesDir)) {
    throw new Error("不能删除工作区共享根目录");
  }
  if (!existsSync(resolved)) return { ok: true };

  assertAttachmentMetadataHealthy(getWorkspaceAttachmentScope(workspaceSlug));
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    rmSync(resolved, { recursive: true, force: true });
  } else {
    rmSync(resolved, { force: true });
  }
  deleteAttachmentMeta(getWorkspaceAttachmentScope(workspaceSlug), resolved);
  return { ok: true };
}

export function deleteWorkspaceRootFile(
  workspaceSlug: string,
  targetPath: string,
): { ok: true } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(
    workspaceRoot,
    targetPath,
    "目标路径超出工作区根目录",
  );
  if (resolve(resolved) === resolve(workspaceRoot)) {
    throw new Error("不能删除工作区根目录");
  }
  if (!existsSync(resolved)) return { ok: true };

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    rmSync(resolved, { recursive: true, force: true });
  } else {
    rmSync(resolved, { force: true });
  }
  return { ok: true };
}

export function renameAgentFile(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
  newName: string,
): { ok: true; path: string; warning?: string } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  const rootPath = resolveSessionDir(workspaceSlug, sessionId);
  if (resolve(resolved) === resolve(rootPath)) {
    throw new Error("不能重命名线程根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  const safeName = validateNewName(newName);
  const nextPath = join(dirname(resolved), safeName);
  if (!isWithin(rootPath, nextPath)) {
    throw new Error("重命名后路径超出线程工作目录");
  }
  if (existsSync(nextPath)) {
    throw new Error("目标名称已存在");
  }
  assertAttachmentMetadataHealthy(
    getThreadAttachmentScope(workspaceSlug, sessionId),
  );
  const moveWarning = movePathWithFallback(resolved, nextPath);
  moveAttachmentMeta(
    getThreadAttachmentScope(workspaceSlug, sessionId),
    resolved,
    nextPath,
  );
  return { ok: true, path: nextPath, ...(moveWarning ? { warning: moveWarning } : {}) };
}

export function renameWorkspaceFile(
  workspaceSlug: string,
  targetPath: string,
  newName: string,
): { ok: true; path: string; warning?: string } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(
    resourcesDir,
    targetPath,
    "目标路径超出工作区共享目录",
  );
  if (resolve(resolved) === resolve(resourcesDir)) {
    throw new Error("不能重命名工作区共享根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  const safeName = validateNewName(newName);
  const nextPath = join(dirname(resolved), safeName);
  if (!isWithin(resourcesDir, nextPath)) {
    throw new Error("重命名后路径超出工作区共享目录");
  }
  if (existsSync(nextPath)) {
    throw new Error("目标名称已存在");
  }
  assertAttachmentMetadataHealthy(getWorkspaceAttachmentScope(workspaceSlug));
  const moveWarning = movePathWithFallback(resolved, nextPath);
  moveAttachmentMeta(
    getWorkspaceAttachmentScope(workspaceSlug),
    resolved,
    nextPath,
  );
  return { ok: true, path: nextPath, ...(moveWarning ? { warning: moveWarning } : {}) };
}

export function renameWorkspaceRootFile(
  workspaceSlug: string,
  targetPath: string,
  newName: string,
): { ok: true; path: string; warning?: string } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(
    workspaceRoot,
    targetPath,
    "目标路径超出工作区根目录",
  );
  if (resolve(resolved) === resolve(workspaceRoot)) {
    throw new Error("不能重命名工作区根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  const safeName = validateNewName(newName);
  const nextPath = join(dirname(resolved), safeName);
  if (!isWithin(workspaceRoot, nextPath)) {
    throw new Error("重命名后路径超出工作区根目录");
  }
  if (existsSync(nextPath)) {
    throw new Error("目标名称已存在");
  }
  const moveWarning = movePathWithFallback(resolved, nextPath);
  return { ok: true, path: nextPath, ...(moveWarning ? { warning: moveWarning } : {}) };
}

export function moveAgentFile(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
  targetDir: string,
): { ok: true; path: string; warning?: string } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  const rootPath = resolveSessionDir(workspaceSlug, sessionId);
  const resolvedTargetDir = resolveSafeTarget(
    workspaceSlug,
    sessionId,
    targetDir,
  );

  if (resolve(resolved) === resolve(rootPath)) {
    throw new Error("不能移动线程根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  if (
    !existsSync(resolvedTargetDir) ||
    !statSync(resolvedTargetDir).isDirectory()
  ) {
    throw new Error("目标目录不存在");
  }

  const nextPath = join(resolvedTargetDir, basename(resolved));
  if (!isWithin(rootPath, nextPath)) {
    throw new Error("移动后路径超出线程工作目录");
  }
  if (resolve(nextPath) === resolve(resolved)) {
    return { ok: true, path: nextPath };
  }
  if (existsSync(nextPath)) {
    throw new Error("目标路径已存在同名文件");
  }

  assertAttachmentMetadataHealthy(
    getThreadAttachmentScope(workspaceSlug, sessionId),
  );
  const moveWarning = movePathWithFallback(resolved, nextPath);
  moveAttachmentMeta(
    getThreadAttachmentScope(workspaceSlug, sessionId),
    resolved,
    nextPath,
  );
  return { ok: true, path: nextPath, ...(moveWarning ? { warning: moveWarning } : {}) };
}

export function moveWorkspaceFile(
  workspaceSlug: string,
  targetPath: string,
  targetDir: string,
): { ok: true; path: string; warning?: string } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(
    resourcesDir,
    targetPath,
    "目标路径超出工作区共享目录",
  );
  const resolvedTargetDir = resolveSafePath(
    resourcesDir,
    targetDir,
    "目标路径超出工作区共享目录",
  );

  if (resolve(resolved) === resolve(resourcesDir)) {
    throw new Error("不能移动工作区共享根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  if (
    !existsSync(resolvedTargetDir) ||
    !statSync(resolvedTargetDir).isDirectory()
  ) {
    throw new Error("目标目录不存在");
  }

  const nextPath = join(resolvedTargetDir, basename(resolved));
  if (!isWithin(resourcesDir, nextPath)) {
    throw new Error("移动后路径超出工作区共享目录");
  }
  if (resolve(nextPath) === resolve(resolved)) {
    return { ok: true, path: nextPath };
  }
  if (existsSync(nextPath)) {
    throw new Error("目标路径已存在同名文件");
  }

  assertAttachmentMetadataHealthy(getWorkspaceAttachmentScope(workspaceSlug));
  const moveWarning = movePathWithFallback(resolved, nextPath);
  moveAttachmentMeta(
    getWorkspaceAttachmentScope(workspaceSlug),
    resolved,
    nextPath,
  );
  return { ok: true, path: nextPath, ...(moveWarning ? { warning: moveWarning } : {}) };
}

export function moveWorkspaceRootFile(
  workspaceSlug: string,
  targetPath: string,
  targetDir: string,
): { ok: true; path: string; warning?: string } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(
    workspaceRoot,
    targetPath,
    "目标路径超出工作区根目录",
  );
  const resolvedTargetDir = resolveSafePath(
    workspaceRoot,
    targetDir,
    "目标路径超出工作区根目录",
  );

  if (resolve(resolved) === resolve(workspaceRoot)) {
    throw new Error("不能移动工作区根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  if (
    !existsSync(resolvedTargetDir) ||
    !statSync(resolvedTargetDir).isDirectory()
  ) {
    throw new Error("目标目录不存在");
  }

  const nextPath = join(resolvedTargetDir, basename(resolved));
  if (!isWithin(workspaceRoot, nextPath)) {
    throw new Error("移动后路径超出工作区根目录");
  }
  if (resolve(nextPath) === resolve(resolved)) {
    return { ok: true, path: nextPath };
  }
  if (existsSync(nextPath)) {
    throw new Error("目标路径已存在同名文件");
  }

  const moveWarning = movePathWithFallback(resolved, nextPath);
  return { ok: true, path: nextPath, ...(moveWarning ? { warning: moveWarning } : {}) };
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  // 无 error 监听会踩中 sidecar uncaughtException 五击止损通道（#548）；吞错但必须留痕
  child.once("error", (error) => {
    log.warn("spawnDetached 失败（打开文件/文件夹）", { command, args, error: error.message });
  });
  child.unref();
}

function openInSystem(path: string): void {
  if (process.platform === "win32") {
    spawnDetached("explorer.exe", [path]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", [path]);
    return;
  }
  spawnDetached("xdg-open", [path]);
}

function showInSystemFolder(resolvedPath: string): void {
  if (process.platform === "win32") {
    spawnDetached("explorer", ["/select,", resolvedPath]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", ["-R", resolvedPath]);
    return;
  }
  openInSystem(dirname(resolvedPath));
}

export function openAgentPath(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
): { ok: true } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  openInSystem(resolved);
  return { ok: true };
}

export function openWorkspacePath(
  workspaceSlug: string,
  targetPath: string,
): { ok: true } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(
    resourcesDir,
    targetPath,
    "目标路径超出工作区共享目录",
  );
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  openInSystem(resolved);
  return { ok: true };
}

export function openWorkspaceRootPath(
  workspaceSlug: string,
  targetPath: string,
): { ok: true } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(
    workspaceRoot,
    targetPath,
    "目标路径超出工作区根目录",
  );
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  openInSystem(resolved);
  return { ok: true };
}

export function previewAgentPath(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
): { ok: true } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  openInSystem(resolved);
  return { ok: true };
}

export function previewWorkspacePath(
  workspaceSlug: string,
  targetPath: string,
): { ok: true } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(
    resourcesDir,
    targetPath,
    "目标路径超出工作区共享目录",
  );
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  openInSystem(resolved);
  return { ok: true };
}

/** 预览直读路径的载入上限（与 readFileRefDocument 的 FILE_LOAD_LIMIT 对齐；statSync 前置防大文件全量载入阻塞事件循环）。 */
const PREVIEW_LOAD_LIMIT_BYTES = 20 * 1024 * 1024;

function readPreviewableText(resolvedPath: string): {
  content: string;
  truncated: boolean;
} {
  if (statSync(resolvedPath).size > PREVIEW_LOAD_LIMIT_BYTES) {
    throw new Error("文件过大，暂不支持预览（上限 20MB）");
  }
  const bytes = readFileSync(resolvedPath);
  const limit = 512 * 1024;
  const sampled = bytes.subarray(0, Math.min(bytes.length, 2048));
  if (sampled.includes(0)) {
    throw new Error("暂不支持预览二进制文件");
  }
  const truncated = bytes.length > limit;
  return {
    content: bytes.subarray(0, limit).toString("utf-8"),
    truncated,
  };
}

export function readAgentPath(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
): { content: string; truncated: boolean } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  return readPreviewableText(resolved);
}

export function readAgentFileData(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
): { data: string; size: number } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error("目标不存在");
  }
  const bytes = readFileSync(resolved);
  return {
    data: bytes.toString("base64"),
    size: bytes.byteLength,
  };
}

export function readWorkspacePath(
  workspaceSlug: string,
  targetPath: string,
): { content: string; truncated: boolean } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(
    resourcesDir,
    targetPath,
    "目标路径超出工作区共享目录",
  );
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  return readPreviewableText(resolved);
}

export function readWorkspaceFileData(
  workspaceSlug: string,
  targetPath: string,
): { data: string; size: number } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(
    resourcesDir,
    targetPath,
    "目标路径超出工作区共享目录",
  );
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error("目标不存在");
  }
  const bytes = readFileSync(resolved);
  return { data: bytes.toString("base64"), size: bytes.byteLength };
}

export function readProjectPath(
  workspaceSlug: string,
  targetPath: string,
): { content: string; truncated: boolean } {
  const resolved = resolveExistingProjectTarget(workspaceSlug, targetPath);
  if (!statSync(resolved).isFile()) {
    throw new Error("目标不是文件");
  }
  return readPreviewableText(resolved);
}

export function readProjectFileData(
  workspaceSlug: string,
  targetPath: string,
): { data: string; size: number } {
  const resolved = resolveExistingProjectTarget(workspaceSlug, targetPath);
  if (!statSync(resolved).isFile()) {
    throw new Error("目标不是文件");
  }
  const bytes = readFileSync(resolved);
  return { data: bytes.toString("base64"), size: bytes.byteLength };
}

export function openProjectPath(
  workspaceSlug: string,
  targetPath: string,
): { ok: true } {
  openInSystem(resolveExistingProjectTarget(workspaceSlug, targetPath));
  return { ok: true };
}

export function showProjectPathInFolder(
  workspaceSlug: string,
  targetPath: string,
): { ok: true } {
  showInSystemFolder(resolveExistingProjectTarget(workspaceSlug, targetPath));
  return { ok: true };
}

export function readWorkspaceRootPath(
  workspaceSlug: string,
  targetPath: string,
): { content: string; truncated: boolean } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(
    workspaceRoot,
    targetPath,
    "目标路径超出工作区根目录",
  );
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  return readPreviewableText(resolved);
}

export function showAgentPathInFolder(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
): { ok: true } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  showInSystemFolder(resolved);
  return { ok: true };
}

export function showWorkspacePathInFolder(
  workspaceSlug: string,
  targetPath: string,
): { ok: true } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(
    resourcesDir,
    targetPath,
    "目标路径超出工作区共享目录",
  );
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  showInSystemFolder(resolved);
  return { ok: true };
}

function scanWorkspaceFiles(
  rootPath: string,
  query: string,
  limit: number,
): FileSearchResult {
  const ignoreDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    ".next",
    "__pycache__",
    ".venv",
    "build",
    ".cache",
  ]);
  const allEntries: Array<{
    name: string;
    path: string;
    type: "file" | "dir";
  }> = [];
  const safeRoot = resolve(rootPath);

  function scan(dir: string, depth: number): void {
    if (depth > 5) return;
    let items: Dirent[];
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      if (item.isDirectory() && ignoreDirs.has(item.name)) continue;
      const fullPath = resolve(dir, item.name);
      const relPath = relative(safeRoot, fullPath).split(sep).join("/");
      allEntries.push({
        name: item.name,
        path: relPath,
        type: item.isDirectory() ? "dir" : "file",
      });
      if (item.isDirectory()) {
        scan(fullPath, depth + 1);
      }
    }
  }

  scan(safeRoot, 0);

  const q = query.trim().toLowerCase();
  if (!q) {
    return { entries: allEntries.slice(0, limit), total: allEntries.length };
  }

  const matched = allEntries.filter((entry) => {
    const nameLower = entry.name.toLowerCase();
    const pathLower = entry.path.toLowerCase();
    if (nameLower.startsWith(q)) return true;
    if (nameLower.includes(q) || pathLower.includes(q)) return true;
    let qi = 0;
    for (let i = 0; i < nameLower.length && qi < q.length; i += 1) {
      if (nameLower[i] === q[qi]) qi += 1;
    }
    return qi === q.length;
  });

  matched.sort((a, b) => {
    const aStartsWith = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bStartsWith = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith;
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.path.length - b.path.length;
  });

  return { entries: matched.slice(0, limit), total: matched.length };
}

export function searchAgentWorkspaceFiles(
  workspaceSlug: string,
  sessionId: string,
  query: string,
  limit = 20,
  rootPath?: string,
): FileSearchResult {
  const root = resolveSafeTarget(workspaceSlug, sessionId, rootPath);
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.floor(limit)))
    : 20;
  return scanWorkspaceFiles(root, query, safeLimit);
}

const DEFAULT_SEARCH_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".cache",
]);

export async function searchAuthorizedFiles(
  rootRef: FileRef,
  query: string,
  options: {
    limit?: number;
    includeExcluded?: boolean;
    maxEntries?: number;
    maxMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<FileSearchResult> {
  if (
    rootRef.source === "memory" &&
    !normalizeAuthorizedRelativePath(rootRef.relativePath)
  ) {
    if (options.signal?.aborted)
      throw new DOMException("File search aborted", "AbortError");
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 200)));
    const queryText = query.trim().toLocaleLowerCase("en-US");
    const sourceFiles = listMemorySourceFilesForScope(rootRef.scopeId);
    const matched = sourceFiles.filter((entry) =>
      entry.ref.relativePath.toLocaleLowerCase("en-US").includes(queryText),
    );
    return {
      entries: matched.slice(0, limit).map((entry) => ({
        name: basename(entry.ref.relativePath),
        path: entry.ref.relativePath,
        type: "file",
        ref: entry.ref,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
      })),
      total: matched.length,
      scanned: sourceFiles.length,
      truncated: matched.length > limit,
    };
  }
  const resolvedRoot = resolveAuthorizedFileRef(rootRef);
  const rootStat = await stat(resolvedRoot.absolutePath);
  if (!rootStat.isDirectory()) throw new Error("搜索根必须是目录");
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 200)));
  const maxEntries = Math.max(limit, options.maxEntries ?? 20_000);
  const deadline = Date.now() + (options.maxMs ?? 2_000);
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const entries: FileSearchResult["entries"] = [];
  const queue = [resolvedRoot.absolutePath];
  let scanned = 0;
  let matched = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (options.signal?.aborted)
      throw new DOMException("File search aborted", "AbortError");
    if (scanned >= maxEntries || Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (options.signal?.aborted)
        throw new DOMException("File search aborted", "AbortError");
      if (scanned >= maxEntries || Date.now() >= deadline) {
        truncated = true;
        break;
      }
      scanned += 1;
      const absolutePath = join(dir, item.name);
      let metadata;
      try {
        metadata = await lstat(absolutePath);
      } catch {
        continue;
      }
      if (metadata.isSymbolicLink()) continue;
      const relativePath = relative(resolvedRoot.rootPath, absolutePath)
        .split(sep)
        .join("/");
      const isDirectory = metadata.isDirectory();
      if (
        isDirectory &&
        !options.includeExcluded &&
        DEFAULT_SEARCH_EXCLUDED_DIRS.has(item.name.toLowerCase())
      )
        continue;
      if (isDirectory) queue.push(absolutePath);
      const haystack = `${item.name}\n${relativePath}`.toLocaleLowerCase(
        "en-US",
      );
      if (!normalizedQuery || haystack.includes(normalizedQuery)) {
        matched += 1;
        if (entries.length < limit) {
          entries.push({
            name: item.name,
            path: relativePath,
            type: isDirectory ? "dir" : "file",
            ref: { ...rootRef, relativePath },
          });
        } else {
          truncated = true;
        }
      }
      if (scanned % 100 === 0)
        await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
  }
  return { entries, total: matched, truncated, scanned };
}

export function saveFilesToAgentSession(
  input: AgentSaveFilesInput,
): AgentSavedFile[] {
  const sessionDir = resolveSessionDir(input.workspaceSlug, input.threadId);
  const results: AgentSavedFile[] = [];
  const scope = getThreadAttachmentScope(input.workspaceSlug, input.threadId);
  assertAttachmentMetadataHealthy(scope);
  const preparedFiles = prepareAgentAttachmentFiles(input.files);

  try {
    for (const prepared of preparedFiles) {
      const { file, bytes, mediaType, contentHash } = prepared;
      const targetPath = input.clientSubmissionId
        ? resolveUniqueAttachmentTarget(sessionDir, file.filename)
        : resolve(join(sessionDir, file.filename));
      if (!isWithin(sessionDir, targetPath)) {
        throw new Error(`文件路径越界: ${file.filename}`);
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, bytes);
      const threadPath = toThreadRelativePath(
        input.workspaceSlug,
        input.threadId,
        targetPath,
      );
      results.push({
        ...(file.id ? { id: file.id } : {}),
        filename: file.filename,
        targetPath,
        threadPath,
        mediaType,
        size: bytes.byteLength,
        contentHash,
        ...(scope.fileContextId
          ? {
              ref: {
                source: "session",
                scopeId: scope.fileContextId,
                relativePath: threadPath,
              },
            }
          : {}),
      });
      if (
        file.sourcePath &&
        file.sourcePath.trim() &&
        isExternalSourcePath(
          input.workspaceSlug,
          file.sourcePath,
          input.threadId,
        )
      ) {
        upsertAttachmentMeta(scope, targetPath, {
          label: "外部附加",
          absoluteSourcePath: resolve(file.sourcePath),
        });
      } else {
        deleteAttachmentMeta(scope, targetPath);
      }
    }
  } catch (error) {
    for (const saved of results) {
      if (existsSync(saved.targetPath))
        rmSync(saved.targetPath, { force: true });
      deleteAttachmentMeta(scope, saved.targetPath);
    }
    throw error;
  }

  return results;
}

/** Desktop attachment path: copy through bounded streams instead of buffering each file in memory. */
export async function saveFilesToAgentSessionStreamed(
  input: AgentSaveFilesInput,
): Promise<AgentSavedFile[]> {
  if (input.files.some((file) => !file.sourcePath?.trim()))
    return saveFilesToAgentSession(input);
  if (input.files.length > AGENT_ATTACHMENT_LIMITS.maxCount) {
    throw new Error(
      `每条消息最多添加 ${AGENT_ATTACHMENT_LIMITS.maxCount} 个附件`,
    );
  }

  const opened = input.files.map((file) => openStreamedAttachmentSource(file));
  const totalBytes = opened.reduce((total, item) => total + item.size, 0);
  if (totalBytes > AGENT_ATTACHMENT_LIMITS.maxTotalBytes) {
    opened.forEach((item) => closeSync(item.fd));
    throw new Error("附件总大小不能超过 50 MB");
  }

  const sessionDir = resolveSessionDir(input.workspaceSlug, input.threadId);
  const scope = getThreadAttachmentScope(input.workspaceSlug, input.threadId);
  const results: AgentSavedFile[] = [];
  const temporaryPaths: string[] = [];
  assertAttachmentMetadataHealthy(scope);

  try {
    for (const item of opened) {
      const targetPath = input.clientSubmissionId
        ? resolveUniqueAttachmentTarget(sessionDir, item.file.filename)
        : resolve(join(sessionDir, item.file.filename));
      if (!isWithin(sessionDir, targetPath))
        throw new Error(`文件路径越界: ${item.file.filename}`);
      mkdirSync(dirname(targetPath), { recursive: true });
      const temporaryPath = `${targetPath}.${randomUUID()}.part`;
      temporaryPaths.push(temporaryPath);
      const hash = createHash("sha256");
      let copiedBytes = 0;
      const reader = createReadStream(item.sourcePath, {
        fd: item.fd,
        autoClose: false,
        start: 0,
      });
      reader.on("data", (chunk: Buffer) => {
        copiedBytes += chunk.byteLength;
        hash.update(chunk);
      });
      await pipeline(reader, createWriteStream(temporaryPath, { flags: "wx" }));
      const after = fstatSync(item.fd);
      if (
        copiedBytes !== item.size ||
        after.size !== item.size ||
        after.dev !== item.dev ||
        after.ino !== item.ino ||
        after.mtimeMs !== item.mtimeMs
      ) {
        throw new Error(`源文件在读取时发生变化: ${item.file.filename}`);
      }
      renameSync(temporaryPath, targetPath);
      temporaryPaths.splice(temporaryPaths.indexOf(temporaryPath), 1);
      const threadPath = toThreadRelativePath(
        input.workspaceSlug,
        input.threadId,
        targetPath,
      );
      results.push({
        ...(item.file.id ? { id: item.file.id } : {}),
        filename: item.file.filename,
        targetPath,
        threadPath,
        mediaType: item.mediaType,
        size: item.size,
        contentHash: hash.digest("hex"),
        ...(scope.fileContextId
          ? {
              ref: {
                source: "session",
                scopeId: scope.fileContextId,
                relativePath: threadPath,
              },
            }
          : {}),
      });
      if (
        isExternalSourcePath(
          input.workspaceSlug,
          item.sourcePath,
          input.threadId,
        )
      ) {
        upsertAttachmentMeta(scope, targetPath, {
          label: "外部附加",
          absoluteSourcePath: item.sourcePath,
        });
      } else {
        deleteAttachmentMeta(scope, targetPath);
      }
    }
    return results;
  } catch (error) {
    for (const path of temporaryPaths)
      if (existsSync(path)) rmSync(path, { force: true });
    for (const saved of results) {
      if (existsSync(saved.targetPath))
        rmSync(saved.targetPath, { force: true });
      deleteAttachmentMeta(scope, saved.targetPath);
    }
    throw error;
  } finally {
    opened.forEach((item) => closeSync(item.fd));
  }
}

function openStreamedAttachmentSource(
  file: AgentSaveFilesInput["files"][number],
): {
  file: AgentSaveFilesInput["files"][number];
  sourcePath: string;
  fd: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  mediaType: string;
} {
  const sourcePath = resolve(file.sourcePath!);
  if (!existsSync(sourcePath))
    throw new Error(`源文件不存在: ${file.filename}`);
  const linkMetadata = lstatSync(sourcePath);
  if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile())
    throw new Error(`只允许附加普通文件: ${file.filename}`);
  const fd = openSync(sourcePath, "r");
  try {
    const stats = fstatSync(fd);
    if (
      !stats.isFile() ||
      stats.dev !== linkMetadata.dev ||
      stats.ino !== linkMetadata.ino
    ) {
      throw new Error(`源文件在读取前发生变化: ${file.filename}`);
    }
    if (stats.size > AGENT_ATTACHMENT_LIMITS.maxFileBytes)
      throw new Error(`${file.filename} 超过 25 MB`);
    if (file.size !== undefined && file.size !== stats.size)
      throw new Error(`${file.filename} 在添加后发生变化，请重新选择`);
    const header = Buffer.alloc(Math.min(stats.size, 1024));
    if (header.byteLength > 0) readSync(fd, header, 0, header.byteLength, 0);
    const detectedImageType = detectImageMediaType(header);
    const declaredMediaType = file.mediaType?.trim().toLowerCase();
    if (
      declaredMediaType?.startsWith("image/") &&
      detectedImageType !== declaredMediaType
    ) {
      throw new Error(`${file.filename} 的图片内容与类型不匹配`);
    }
    return {
      file,
      sourcePath,
      fd,
      dev: stats.dev,
      ino: stats.ino,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      mediaType:
        detectedImageType ?? declaredMediaType ?? "application/octet-stream",
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function prepareAgentAttachmentFiles(
  files: AgentSaveFilesInput["files"],
): Array<{
  file: AgentSaveFilesInput["files"][number];
  bytes: Buffer;
  mediaType: string;
  contentHash: string;
}> {
  if (files.length > AGENT_ATTACHMENT_LIMITS.maxCount) {
    throw new Error(
      `每条消息最多添加 ${AGENT_ATTACHMENT_LIMITS.maxCount} 个附件`,
    );
  }

  let totalBytes = 0;
  return files.map((file) => {
    const bytes = file.sourcePath?.trim()
      ? readAttachmentSourceSnapshot(file.sourcePath, file.filename)
      : decodeAttachmentBase64(file.data, file.filename);
    if (bytes.byteLength > AGENT_ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error(`${file.filename} 超过 25 MB`);
    }
    if (file.size !== undefined && file.size !== bytes.byteLength) {
      throw new Error(`${file.filename} 在添加后发生变化，请重新选择`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > AGENT_ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new Error("附件总大小不能超过 50 MB");
    }

    const detectedImageType = detectImageMediaType(bytes);
    const declaredMediaType = file.mediaType?.trim().toLowerCase();
    if (
      declaredMediaType?.startsWith("image/") &&
      detectedImageType !== declaredMediaType
    ) {
      throw new Error(`${file.filename} 的图片内容与类型不匹配`);
    }
    return {
      file,
      bytes,
      mediaType:
        detectedImageType ?? declaredMediaType ?? "application/octet-stream",
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function readAttachmentSourceSnapshot(
  sourcePath: string,
  filename: string,
): Buffer {
  const resolvedSourcePath = resolve(sourcePath);
  if (!existsSync(resolvedSourcePath))
    throw new Error(`源文件不存在: ${filename}`);
  const linkMetadata = lstatSync(resolvedSourcePath);
  if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) {
    throw new Error(`只允许附加普通文件: ${filename}`);
  }

  const fd = openSync(resolvedSourcePath, "r");
  try {
    const openedMetadata = fstatSync(fd);
    if (
      !openedMetadata.isFile() ||
      linkMetadata.dev !== openedMetadata.dev ||
      linkMetadata.ino !== openedMetadata.ino
    ) {
      throw new Error(`源文件在读取前发生变化: ${filename}`);
    }
    if (openedMetadata.size > AGENT_ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error(`${filename} 超过 25 MB`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function decodeAttachmentBase64(
  data: string | undefined,
  filename: string,
): Buffer {
  if (data === undefined) throw new Error(`缺少文件内容: ${filename}`);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  ) {
    throw new Error(`文件内容编码无效: ${filename}`);
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data)
    throw new Error(`文件内容编码无效: ${filename}`);
  return bytes;
}

function detectImageMediaType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM")
    return "image/bmp";
  // AVIF / HEIC(HEIF)\uFF1AISO BMFF\uFF0Coffset 4-8 \u4E3A "ftyp"\uFF0C8-12 \u4E3A major brand\uFF08\u89C1 #14\uFF09
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (
      brand === "heic" ||
      brand === "heix" ||
      brand === "heim" ||
      brand === "heis" ||
      brand === "mif1" ||
      brand === "msf1"
    )
      return "image/heic";
  }
  // ICO\uFF08.cur \u4E3A 00 00 02 00\uFF0C\u6B64\u5904\u4EC5\u8BA4\u56FE\u6807\uFF09
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x01 &&
    bytes[3] === 0x00
  )
    return "image/x-icon";
  // TIFF\uFF08\u542B DNG/NEF \u7B49 TIFF \u884D\u751F\uFF09\uFF1A\u5C0F\u7AEF II*\0 \u6216\u5927\u7AEF MM\0*
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
      (bytes[0] === 0x4d &&
        bytes[1] === 0x4d &&
        bytes[2] === 0x00 &&
        bytes[3] === 0x2a))
  )
    return "image/tiff";
  const textPrefix = bytes
    .subarray(0, Math.min(bytes.length, 1024))
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(textPrefix))
    return "image/svg+xml";
  return undefined;
}

function resolveUniqueAttachmentTarget(
  sessionDir: string,
  filename: string,
): string {
  const initial = resolve(join(sessionDir, filename));
  if (!existsSync(initial)) return initial;
  const extension = extname(filename);
  const stem = basename(filename, extension);
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = resolve(
      join(sessionDir, `${stem} (${suffix})${extension}`),
    );
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`无法为附件分配唯一文件名: ${filename}`);
}

export function saveFilesToWorkspace(
  input: WorkspaceSaveFilesInput,
): AgentSavedFile[] {
  const resourcesDir = resolveWorkspaceResourcesDir(input.workspaceSlug);
  const results: AgentSavedFile[] = [];
  const scope = getWorkspaceAttachmentScope(input.workspaceSlug);
  assertAttachmentMetadataHealthy(scope);

  for (const file of input.files) {
    const targetPath = resolve(join(resourcesDir, file.filename));
    if (!isWithin(resourcesDir, targetPath)) {
      throw new Error(`文件路径越界: ${file.filename}`);
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    if (file.sourcePath && file.sourcePath.trim()) {
      const resolvedSourcePath = resolve(file.sourcePath);
      if (
        !existsSync(resolvedSourcePath) ||
        !statSync(resolvedSourcePath).isFile()
      ) {
        throw new Error(`源文件不存在: ${file.filename}`);
      }
      copyFileSync(resolvedSourcePath, targetPath);
    } else if (file.data) {
      const buffer = Buffer.from(file.data, "base64");
      writeFileSync(targetPath, buffer);
    } else {
      throw new Error(`缺少文件内容: ${file.filename}`);
    }
    results.push({ filename: file.filename, targetPath });
    if (
      file.sourcePath &&
      file.sourcePath.trim() &&
      isExternalSourcePath(input.workspaceSlug, file.sourcePath)
    ) {
      upsertAttachmentMeta(scope, targetPath, {
        label: "外部附加",
        absoluteSourcePath: resolve(file.sourcePath),
      });
    } else {
      deleteAttachmentMeta(scope, targetPath);
    }
  }

  return results;
}

export function saveFilesToWorkspaceRoot(
  input: WorkspaceSaveFilesInput,
): AgentSavedFile[] {
  const workspaceRoot = resolveWorkspaceRootDir(input.workspaceSlug);
  const results: AgentSavedFile[] = [];

  for (const file of input.files) {
    const targetPath = resolve(join(workspaceRoot, file.filename));
    if (!isWithin(workspaceRoot, targetPath)) {
      throw new Error(`文件路径越界: ${file.filename}`);
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    if (file.sourcePath && file.sourcePath.trim()) {
      const resolvedSourcePath = resolve(file.sourcePath);
      if (
        !existsSync(resolvedSourcePath) ||
        !statSync(resolvedSourcePath).isFile()
      ) {
        throw new Error(`源文件不存在: ${file.filename}`);
      }
      copyFileSync(resolvedSourcePath, targetPath);
    } else if (file.data) {
      const buffer = Buffer.from(file.data, "base64");
      writeFileSync(targetPath, buffer);
    } else {
      throw new Error(`缺少文件内容: ${file.filename}`);
    }
    results.push({ filename: file.filename, targetPath });
  }

  return results;
}

export function copyFolderToSession(
  input: AgentCopyFolderInput,
): AgentSavedFile[] {
  const sessionDir = resolveSessionDir(input.workspaceSlug, input.threadId);
  const sourcePath = resolve(input.sourcePath);
  if (!existsSync(sourcePath)) {
    throw new Error("源目录不存在");
  }
  if (!statSync(sourcePath).isDirectory()) {
    throw new Error("源目录不存在");
  }

  const folderName =
    sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? "folder";
  const targetDir = resolve(join(sessionDir, folderName));
  if (!isWithin(sessionDir, targetDir)) {
    throw new Error("目标路径越界");
  }
  if (existsSync(targetDir)) {
    throw new Error("目标路径已存在同名文件");
  }

  assertAttachmentMetadataHealthy(
    getThreadAttachmentScope(input.workspaceSlug, input.threadId),
  );
  cpSync(sourcePath, targetDir, { recursive: true });
  if (isExternalSourcePath(input.workspaceSlug, sourcePath, input.threadId)) {
    upsertAttachmentMeta(
      getThreadAttachmentScope(input.workspaceSlug, input.threadId),
      targetDir,
      {
        label: "外部附加",
        absoluteSourcePath: sourcePath,
      },
    );
  }

  const results: AgentSavedFile[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(fullPath);
      } else {
        const rel = fullPath.slice(sessionDir.length + 1);
        results.push({ filename: rel, targetPath: fullPath });
      }
    }
  };
  collect(targetDir);
  return results;
}

export function copyFolderToWorkspace(
  input: WorkspaceCopyFolderInput,
): AgentSavedFile[] {
  const resourcesDir = resolveWorkspaceResourcesDir(input.workspaceSlug);
  const sourcePath = resolve(input.sourcePath);
  if (!existsSync(sourcePath)) {
    throw new Error("源目录不存在");
  }
  if (!statSync(sourcePath).isDirectory()) {
    throw new Error("源目录不存在");
  }

  const folderName =
    sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? "folder";
  const targetDir = resolve(join(resourcesDir, folderName));
  if (!isWithin(resourcesDir, targetDir)) {
    throw new Error("目标路径越界");
  }
  if (existsSync(targetDir)) {
    throw new Error("目标路径已存在同名文件");
  }

  assertAttachmentMetadataHealthy(
    getWorkspaceAttachmentScope(input.workspaceSlug),
  );
  cpSync(sourcePath, targetDir, { recursive: true });
  if (isExternalSourcePath(input.workspaceSlug, sourcePath)) {
    upsertAttachmentMeta(
      getWorkspaceAttachmentScope(input.workspaceSlug),
      targetDir,
      {
        label: "外部附加",
        absoluteSourcePath: sourcePath,
      },
    );
  }

  const results: AgentSavedFile[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(fullPath);
      } else {
        const rel = fullPath.slice(resourcesDir.length + 1);
        results.push({ filename: rel, targetPath: fullPath });
      }
    }
  };
  collect(targetDir);
  return results;
}

export function attachWorkspaceResourceToThread(
  input: AttachWorkspaceResourceToThreadInput,
): AttachWorkspaceResourceToThreadResult {
  const workspaceScope = getWorkspaceAttachmentScope(input.workspaceSlug);
  const threadScope = getThreadAttachmentScope(
    input.workspaceSlug,
    input.threadId,
  );
  const resourcesDir = resolveWorkspaceResourcesDir(input.workspaceSlug);
  const sourcePath = resolveSafePath(
    resourcesDir,
    input.sourcePath,
    "目标路径超出工作区共享目录",
  );
  const sessionDir = resolveSessionDir(input.workspaceSlug, input.threadId);
  if (!existsSync(sourcePath)) {
    throw new Error("目标不存在");
  }

  const targetPath = resolve(join(sessionDir, basename(sourcePath)));
  if (!isWithin(sessionDir, targetPath)) {
    throw new Error("目标路径越界");
  }
  if (existsSync(targetPath)) {
    throw new Error("目标路径已存在同名文件");
  }

  assertAttachmentMetadataHealthy(workspaceScope);
  assertAttachmentMetadataHealthy(threadScope);

  const sourceMeta = getAttachmentMeta(workspaceScope, sourcePath);
  const sourceStat = statSync(sourcePath);
  if (sourceStat.isDirectory()) {
    cpSync(sourcePath, targetPath, { recursive: true });
  } else {
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  if (sourceMeta) {
    upsertAttachmentMeta(threadScope, targetPath, sourceMeta);
  } else {
    deleteAttachmentMeta(threadScope, targetPath);
  }

  return { ok: true, path: targetPath };
}

export const saveFilesToAgentThread = saveFilesToAgentSession;
export const saveFilesToAgentThreadStreamed = saveFilesToAgentSessionStreamed;
export const copyFolderToThread = copyFolderToSession;
