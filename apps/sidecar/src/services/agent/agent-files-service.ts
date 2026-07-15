import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  type Dirent,
  renameSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AttachWorkspaceResourceToThreadInput,
  AttachWorkspaceResourceToThreadResult,
  AgentCopyFolderInput,
  AgentSaveFilesInput,
  AgentSavedFile,
  ExternalAttachmentMeta,
  FileEntry,
  FileSearchResult,
  WorkspaceCopyFolderInput,
  WorkspaceSaveFilesInput
} from "@lume/shared";
import {
  getAgentThreadRootPath,
  getAgentWorkspacePath,
  getAgentWorkspacesDir
} from "../infra/config-paths";
import { resolveAgentThreadWorkdir } from "./agent-workdir-resolver";
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
  type ThreadAttachmentScope
} from "./agent-attachment-meta-service";

function validatePathSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`${label} 非法`);
  }
}

function isWithin(basePath: string, targetPath: string): boolean {
  const base = resolve(basePath);
  const target = resolve(targetPath);
  if (process.platform === "win32") {
    const b = base.toLowerCase();
    const t = target.toLowerCase();
    return t === b || t.startsWith(`${b}${sep}`);
  }
  return target === base || target.startsWith(`${base}${sep}`);
}

function resolveSessionDir(workspaceSlug: string | undefined, sessionId: string): string {
  validatePathSegment(sessionId, "sessionId");
  try {
    return resolveAgentThreadWorkdir(sessionId).lumeWorkDir;
  } catch (error) {
    if (!workspaceSlug) throw error;
    validatePathSegment(workspaceSlug, "workspaceSlug");
    return getAgentThreadRootPath(workspaceSlug, sessionId);
  }
}

function resolveWorkspaceResourcesDir(workspaceSlug: string): string {
  validatePathSegment(workspaceSlug, "workspaceSlug");
  return join(getAgentWorkspacePath(workspaceSlug), "resources");
}

function resolveWorkspaceRootDir(workspaceSlug: string): string {
  validatePathSegment(workspaceSlug, "workspaceSlug");
  return getAgentWorkspacePath(workspaceSlug);
}

function getThreadAttachmentScope(workspaceSlug: string | undefined, sessionId: string): ThreadAttachmentScope {
  try {
    const resolved = resolveAgentThreadWorkdir(sessionId);
    return {
      kind: "thread",
      workspaceSlug: workspaceSlug ?? resolved.fileContextId,
      threadId: sessionId,
      fileContextId: resolved.fileContextId
    };
  } catch (error) {
    if (!workspaceSlug) throw error;
    return { kind: "thread", workspaceSlug, threadId: sessionId };
  }
}

function resolveExistingProjectTarget(workspaceSlug: string, targetPath?: string): string {
  validatePathSegment(workspaceSlug, "workspaceSlug");
  const workspace = getAgentWorkspaceBySlug(workspaceSlug);
  if (!workspace?.projectPath) {
    throw new Error("项目尚未绑定本地目录");
  }
  const projectRoot = realpathSync(workspace.projectPath);
  const candidate = resolveSafePathWithin(projectRoot, targetPath, "目标路径超出项目目录");
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

function isExternalSourcePath(workspaceSlug: string | undefined, sourcePath: string, threadId?: string): boolean {
  if (threadId) {
    return !isWithin(resolveSessionDir(workspaceSlug, threadId), resolve(sourcePath));
  }
  if (!workspaceSlug) return true;
  const workspaceRoot = resolve(getAgentWorkspacePath(workspaceSlug));
  return !isWithin(workspaceRoot, resolve(sourcePath));
}

function enrichEntriesWithAttachmentMeta(
  entries: FileEntry[],
  rootPath: string,
  metadataByRelativePath: Record<string, ExternalAttachmentMeta>
): FileEntry[] {
  return entries.map((entry) => {
    const relPath = relative(rootPath, entry.path).split(sep).join("/");
    const externalAttachment = metadataByRelativePath[relPath];
    return externalAttachment ? { ...entry, externalAttachment } : entry;
  });
}

export function resolveWorkspaceSlugBySessionId(sessionId: string): string | null {
  validatePathSegment(sessionId, "sessionId");
  const workspacesDir = getAgentWorkspacesDir();
  if (!existsSync(workspacesDir)) return null;
  for (const entry of readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const threadRootCandidate = join(workspacesDir, entry.name, "threads", sessionId);
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

function resolveSafeTarget(workspaceSlug: string | undefined, sessionId: string, targetPath?: string): string {
  const sessionDir = resolveSessionDir(workspaceSlug, sessionId);
  return resolveSafePathWithin(sessionDir, targetPath, "目标路径超出线程工作目录");
}

function resolveSafePath(basePath: string, targetPath?: string, errorMessage = "目标路径超出允许范围"): string {
  return resolveSafePathWithin(basePath, targetPath, errorMessage);
}

function resolveSafePathWithin(basePath: string, targetPath?: string, errorMessage = "目标路径超出允许范围"): string {
  const base = resolve(basePath);
  if (!targetPath || targetPath.trim().length === 0) return base;
  const trimmed = targetPath.trim();
  const resolved = resolve(isAbsolute(trimmed) ? trimmed : join(base, trimmed));
  if (!isWithin(base, resolved)) {
    throw new Error(errorMessage);
  }
  return resolved;
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

function movePathWithFallback(sourcePath: string, targetPath: string): void {
  try {
    renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") {
      throw error;
    }
  }
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    rmSync(targetPath, { recursive: true, force: true });
    cpSync(sourcePath, targetPath, { recursive: true });
    rmSync(sourcePath, { recursive: true, force: true });
  } catch (error) {
    rmSync(targetPath, { recursive: true, force: true });
    throw error;
  }
}

export function getAgentSessionPath(workspaceSlug: string | undefined, sessionId: string): string {
  return resolveSessionDir(workspaceSlug, sessionId);
}

export const getAgentThreadPath = getAgentSessionPath;

export function toThreadRelativePath(workspaceSlug: string | undefined, sessionId: string, targetPath: string): string {
  const sessionDir = resolveSessionDir(workspaceSlug, sessionId);
  const resolved = resolve(targetPath);
  if (!isWithin(sessionDir, resolved)) {
    throw new Error("附件路径不在当前线程目录内");
  }
  return relative(sessionDir, resolved).split(sep).join("/");
}

export function resolveThreadAttachmentPath(workspaceSlug: string | undefined, sessionId: string, threadPath: string): string {
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
  targetPath?: string
): FileEntry[] {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  if (!existsSync(resolved)) return [];
  const sessionRoot = resolveSessionDir(workspaceSlug, sessionId);
  const threadScope = getThreadAttachmentScope(workspaceSlug, sessionId);
  const attachmentMeta = readThreadAttachmentMeta(threadScope.workspaceSlug, sessionId, threadScope.fileContextId);

  const items = readdirSync(resolved, { withFileTypes: true }).map((entry) => {
    const fullPath = join(resolved, entry.name);
    return {
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory()
    } satisfies FileEntry;
  });

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });

  return enrichEntriesWithAttachmentMeta(items, sessionRoot, attachmentMeta);
}

export function listWorkspaceDirectory(
  workspaceSlug: string,
  targetPath?: string
): FileEntry[] {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(resourcesDir, targetPath, "目标路径超出工作区共享目录");
  if (!existsSync(resolved)) return [];
  const attachmentMeta = readWorkspaceAttachmentMeta(workspaceSlug);

  const items = readdirSync(resolved, { withFileTypes: true }).map((entry) => {
    const fullPath = join(resolved, entry.name);
    return {
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory()
    } satisfies FileEntry;
  });

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });

  return enrichEntriesWithAttachmentMeta(items, resourcesDir, attachmentMeta);
}

export function listProjectDirectory(workspaceSlug: string, targetPath?: string): FileEntry[] {
  const resolved = resolveExistingProjectTarget(workspaceSlug, targetPath);
  if (!statSync(resolved).isDirectory()) {
    throw new Error("目标不是目录");
  }
  const items = readdirSync(resolved, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    path: join(resolved, entry.name),
    isDirectory: entry.isDirectory()
  } satisfies FileEntry));
  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });
  return items;
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
  conflict: "error"
): { ok: true; path: string } {
  if (conflict !== "error") {
    throw new Error("旧版资源导出必须显式使用不覆盖策略");
  }
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const lexicalSource = resolveSafePathWithin(resourcesDir, targetPath, "源路径超出旧版资源目录");
  if (!existsSync(lexicalSource)) throw new Error("旧版资源不存在");
  assertLegacyExportSourceSafe(lexicalSource);
  const source = realpathSync(lexicalSource);
  if (!isWithin(realpathSync(resourcesDir), source)) throw new Error("源路径超出旧版资源目录");

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
      }
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
export function listWorkspaceRootDirectory(
  workspaceSlug: string,
  targetPath?: string
): FileEntry[] {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(workspaceRoot, targetPath, "目标路径超出工作区根目录");
  if (!existsSync(resolved)) return [];

  const items = readdirSync(resolved, { withFileTypes: true }).map((entry) => {
    const fullPath = join(resolved, entry.name);
    return {
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory()
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
  targetPath: string
): { ok: true } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  const rootPath = resolveSessionDir(workspaceSlug, sessionId);
  if (resolve(resolved) === resolve(rootPath)) {
    throw new Error("不能删除线程根目录");
  }
  if (!existsSync(resolved)) return { ok: true };

  assertAttachmentMetadataHealthy(getThreadAttachmentScope(workspaceSlug, sessionId));
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    rmSync(resolved, { recursive: true, force: true });
  } else {
    rmSync(resolved, { force: true });
  }
  deleteAttachmentMeta(getThreadAttachmentScope(workspaceSlug, sessionId), resolved);
  return { ok: true };
}

export function deleteWorkspaceFile(
  workspaceSlug: string,
  targetPath: string
): { ok: true } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(resourcesDir, targetPath, "目标路径超出工作区共享目录");
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
  targetPath: string
): { ok: true } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(workspaceRoot, targetPath, "目标路径超出工作区根目录");
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
  newName: string
): { ok: true; path: string } {
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
  assertAttachmentMetadataHealthy(getThreadAttachmentScope(workspaceSlug, sessionId));
  movePathWithFallback(resolved, nextPath);
  moveAttachmentMeta(getThreadAttachmentScope(workspaceSlug, sessionId), resolved, nextPath);
  return { ok: true, path: nextPath };
}

export function renameWorkspaceFile(
  workspaceSlug: string,
  targetPath: string,
  newName: string
): { ok: true; path: string } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(resourcesDir, targetPath, "目标路径超出工作区共享目录");
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
  movePathWithFallback(resolved, nextPath);
  moveAttachmentMeta(getWorkspaceAttachmentScope(workspaceSlug), resolved, nextPath);
  return { ok: true, path: nextPath };
}

export function renameWorkspaceRootFile(
  workspaceSlug: string,
  targetPath: string,
  newName: string
): { ok: true; path: string } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(workspaceRoot, targetPath, "目标路径超出工作区根目录");
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
  movePathWithFallback(resolved, nextPath);
  return { ok: true, path: nextPath };
}

export function moveAgentFile(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string,
  targetDir: string
): { ok: true; path: string } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  const rootPath = resolveSessionDir(workspaceSlug, sessionId);
  const resolvedTargetDir = resolveSafeTarget(workspaceSlug, sessionId, targetDir);

  if (resolve(resolved) === resolve(rootPath)) {
    throw new Error("不能移动线程根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  if (!existsSync(resolvedTargetDir) || !statSync(resolvedTargetDir).isDirectory()) {
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

  assertAttachmentMetadataHealthy(getThreadAttachmentScope(workspaceSlug, sessionId));
  movePathWithFallback(resolved, nextPath);
  moveAttachmentMeta(getThreadAttachmentScope(workspaceSlug, sessionId), resolved, nextPath);
  return { ok: true, path: nextPath };
}

export function moveWorkspaceFile(
  workspaceSlug: string,
  targetPath: string,
  targetDir: string
): { ok: true; path: string } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(resourcesDir, targetPath, "目标路径超出工作区共享目录");
  const resolvedTargetDir = resolveSafePath(resourcesDir, targetDir, "目标路径超出工作区共享目录");

  if (resolve(resolved) === resolve(resourcesDir)) {
    throw new Error("不能移动工作区共享根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  if (!existsSync(resolvedTargetDir) || !statSync(resolvedTargetDir).isDirectory()) {
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
  movePathWithFallback(resolved, nextPath);
  moveAttachmentMeta(getWorkspaceAttachmentScope(workspaceSlug), resolved, nextPath);
  return { ok: true, path: nextPath };
}

export function moveWorkspaceRootFile(
  workspaceSlug: string,
  targetPath: string,
  targetDir: string
): { ok: true; path: string } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(workspaceRoot, targetPath, "目标路径超出工作区根目录");
  const resolvedTargetDir = resolveSafePath(workspaceRoot, targetDir, "目标路径超出工作区根目录");

  if (resolve(resolved) === resolve(workspaceRoot)) {
    throw new Error("不能移动工作区根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  if (!existsSync(resolvedTargetDir) || !statSync(resolvedTargetDir).isDirectory()) {
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

  movePathWithFallback(resolved, nextPath);
  return { ok: true, path: nextPath };
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function openInSystem(path: string): void {
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", path]);
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
  targetPath: string
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
  targetPath: string
): { ok: true } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(resourcesDir, targetPath, "目标路径超出工作区共享目录");
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  openInSystem(resolved);
  return { ok: true };
}

export function openWorkspaceRootPath(
  workspaceSlug: string,
  targetPath: string
): { ok: true } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(workspaceRoot, targetPath, "目标路径超出工作区根目录");
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  openInSystem(resolved);
  return { ok: true };
}

export function previewAgentPath(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string
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
  targetPath: string
): { ok: true } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(resourcesDir, targetPath, "目标路径超出工作区共享目录");
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  openInSystem(resolved);
  return { ok: true };
}

function readPreviewableText(resolvedPath: string): { content: string; truncated: boolean } {
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
  targetPath: string
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
  targetPath: string
): { data: string; size: number } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error("目标不存在");
  }
  const bytes = readFileSync(resolved);
  return {
    data: bytes.toString("base64"),
    size: bytes.byteLength
  };
}

export function readWorkspacePath(
  workspaceSlug: string,
  targetPath: string
): { content: string; truncated: boolean } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(resourcesDir, targetPath, "目标路径超出工作区共享目录");
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  return readPreviewableText(resolved);
}

export function readWorkspaceFileData(
  workspaceSlug: string,
  targetPath: string
): { data: string; size: number } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(resourcesDir, targetPath, "目标路径超出工作区共享目录");
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error("目标不存在");
  }
  const bytes = readFileSync(resolved);
  return { data: bytes.toString("base64"), size: bytes.byteLength };
}

export function readProjectPath(
  workspaceSlug: string,
  targetPath: string
): { content: string; truncated: boolean } {
  const resolved = resolveExistingProjectTarget(workspaceSlug, targetPath);
  if (!statSync(resolved).isFile()) {
    throw new Error("目标不是文件");
  }
  return readPreviewableText(resolved);
}

export function readProjectFileData(
  workspaceSlug: string,
  targetPath: string
): { data: string; size: number } {
  const resolved = resolveExistingProjectTarget(workspaceSlug, targetPath);
  if (!statSync(resolved).isFile()) {
    throw new Error("目标不是文件");
  }
  const bytes = readFileSync(resolved);
  return { data: bytes.toString("base64"), size: bytes.byteLength };
}

export function openProjectPath(workspaceSlug: string, targetPath: string): { ok: true } {
  openInSystem(resolveExistingProjectTarget(workspaceSlug, targetPath));
  return { ok: true };
}

export function showProjectPathInFolder(workspaceSlug: string, targetPath: string): { ok: true } {
  showInSystemFolder(resolveExistingProjectTarget(workspaceSlug, targetPath));
  return { ok: true };
}

export function readWorkspaceRootPath(
  workspaceSlug: string,
  targetPath: string
): { content: string; truncated: boolean } {
  const workspaceRoot = resolveWorkspaceRootDir(workspaceSlug);
  const resolved = resolveSafePath(workspaceRoot, targetPath, "目标路径超出工作区根目录");
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  return readPreviewableText(resolved);
}

export function showAgentPathInFolder(
  workspaceSlug: string | undefined,
  sessionId: string,
  targetPath: string
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
  targetPath: string
): { ok: true } {
  const resourcesDir = resolveWorkspaceResourcesDir(workspaceSlug);
  const resolved = resolveSafePath(resourcesDir, targetPath, "目标路径超出工作区共享目录");
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  showInSystemFolder(resolved);
  return { ok: true };
}

function scanWorkspaceFiles(
  rootPath: string,
  query: string,
  limit: number
): FileSearchResult {
  const ignoreDirs = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".venv", "build", ".cache"]);
  const allEntries: Array<{ name: string; path: string; type: "file" | "dir" }> = [];
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
        type: item.isDirectory() ? "dir" : "file"
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
  rootPath?: string
): FileSearchResult {
  const root = resolveSafeTarget(workspaceSlug, sessionId, rootPath);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 20;
  return scanWorkspaceFiles(root, query, safeLimit);
}

export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = resolveSessionDir(input.workspaceSlug, input.threadId);
  const results: AgentSavedFile[] = [];
  const scope = getThreadAttachmentScope(input.workspaceSlug, input.threadId);
  assertAttachmentMetadataHealthy(scope);

  for (const file of input.files) {
    const targetPath = resolve(join(sessionDir, file.filename));
    if (!isWithin(sessionDir, targetPath)) {
      throw new Error(`文件路径越界: ${file.filename}`);
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    if (file.sourcePath && file.sourcePath.trim()) {
      const resolvedSourcePath = resolve(file.sourcePath);
      if (!existsSync(resolvedSourcePath) || !statSync(resolvedSourcePath).isFile()) {
        throw new Error(`源文件不存在: ${file.filename}`);
      }
      copyFileSync(resolvedSourcePath, targetPath);
    } else if (file.data) {
      const buffer = Buffer.from(file.data, "base64");
      writeFileSync(targetPath, buffer);
    } else {
      throw new Error(`缺少文件内容: ${file.filename}`);
    }
    results.push({
      filename: file.filename,
      targetPath,
      threadPath: toThreadRelativePath(input.workspaceSlug, input.threadId, targetPath)
    });
    if (file.sourcePath && file.sourcePath.trim() && isExternalSourcePath(input.workspaceSlug, file.sourcePath, input.threadId)) {
      upsertAttachmentMeta(scope, targetPath, {
        label: "外部附加",
        absoluteSourcePath: resolve(file.sourcePath)
      });
    } else {
      deleteAttachmentMeta(scope, targetPath);
    }
  }

  return results;
}

export function saveFilesToWorkspace(input: WorkspaceSaveFilesInput): AgentSavedFile[] {
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
      if (!existsSync(resolvedSourcePath) || !statSync(resolvedSourcePath).isFile()) {
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
    if (file.sourcePath && file.sourcePath.trim() && isExternalSourcePath(input.workspaceSlug, file.sourcePath)) {
      upsertAttachmentMeta(scope, targetPath, {
        label: "外部附加",
        absoluteSourcePath: resolve(file.sourcePath)
      });
    } else {
      deleteAttachmentMeta(scope, targetPath);
    }
  }

  return results;
}

export function saveFilesToWorkspaceRoot(input: WorkspaceSaveFilesInput): AgentSavedFile[] {
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
      if (!existsSync(resolvedSourcePath) || !statSync(resolvedSourcePath).isFile()) {
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

export function copyFolderToSession(input: AgentCopyFolderInput): AgentSavedFile[] {
  const sessionDir = resolveSessionDir(input.workspaceSlug, input.threadId);
  const sourcePath = resolve(input.sourcePath);
  if (!existsSync(sourcePath)) {
    throw new Error("源目录不存在");
  }
  if (!statSync(sourcePath).isDirectory()) {
    throw new Error("源目录不存在");
  }

  const folderName = sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? "folder";
  const targetDir = resolve(join(sessionDir, folderName));
  if (!isWithin(sessionDir, targetDir)) {
    throw new Error("目标路径越界");
  }
  if (existsSync(targetDir)) {
    throw new Error("目标路径已存在同名文件");
  }

  assertAttachmentMetadataHealthy(getThreadAttachmentScope(input.workspaceSlug, input.threadId));
  cpSync(sourcePath, targetDir, { recursive: true });
  if (isExternalSourcePath(input.workspaceSlug, sourcePath, input.threadId)) {
    upsertAttachmentMeta(getThreadAttachmentScope(input.workspaceSlug, input.threadId), targetDir, {
      label: "外部附加",
      absoluteSourcePath: sourcePath
    });
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

export function copyFolderToWorkspace(input: WorkspaceCopyFolderInput): AgentSavedFile[] {
  const resourcesDir = resolveWorkspaceResourcesDir(input.workspaceSlug);
  const sourcePath = resolve(input.sourcePath);
  if (!existsSync(sourcePath)) {
    throw new Error("源目录不存在");
  }
  if (!statSync(sourcePath).isDirectory()) {
    throw new Error("源目录不存在");
  }

  const folderName = sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? "folder";
  const targetDir = resolve(join(resourcesDir, folderName));
  if (!isWithin(resourcesDir, targetDir)) {
    throw new Error("目标路径越界");
  }
  if (existsSync(targetDir)) {
    throw new Error("目标路径已存在同名文件");
  }

  assertAttachmentMetadataHealthy(getWorkspaceAttachmentScope(input.workspaceSlug));
  cpSync(sourcePath, targetDir, { recursive: true });
  if (isExternalSourcePath(input.workspaceSlug, sourcePath)) {
    upsertAttachmentMeta(getWorkspaceAttachmentScope(input.workspaceSlug), targetDir, {
      label: "外部附加",
      absoluteSourcePath: sourcePath
    });
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
  input: AttachWorkspaceResourceToThreadInput
): AttachWorkspaceResourceToThreadResult {
  const workspaceScope = getWorkspaceAttachmentScope(input.workspaceSlug);
  const threadScope = getThreadAttachmentScope(input.workspaceSlug, input.threadId);
  const resourcesDir = resolveWorkspaceResourcesDir(input.workspaceSlug);
  const sourcePath = resolveSafePath(resourcesDir, input.sourcePath, "目标路径超出工作区共享目录");
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
export const copyFolderToThread = copyFolderToSession;
