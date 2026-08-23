import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { AgentThreadMeta, AgentWorkspace } from "@lume/shared";
import {
  getAgentFileContextArtifactsPath,
  getAgentFileContextFilesPath,
  getAgentFileContextPlansPath,
  getAgentFileContextRootPath,
  getAgentFileContextSystemContextPath,
  getAgentFileContextsDir,
  getAgentWorkspacesDir,
  getAgentWorkspacePath
} from "../infra/config-paths";
import { withIndexMutationLock } from "../infra/index-mutation-lock";
import { threadStore } from "./agent-thread-store-holder";
import { workspaceStore } from "./agent-workspace-store-holder";
import { createLogger } from "../infra/logger";

export interface ResolvedAgentWorkdir {
  agentCwd: string;
  lumeWorkDir: string;
  projectRoot?: string;
  fileContextId: string;
  filesRoot: string;
  plansRoot: string;
  artifactsRoot: string;
}

const MIGRATION_MARKER = ".migration-v1.json";
const EMPTY_CONTEXT_DIRS = new Set(["files", "plans", "artifacts", ".context"]);
const log = createLogger("agent-workdir-resolver");

export function normalizeRealpathKey(path: string): string {
  const resolved = realpathSync(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function assertExistingDirectory(path: string, label = "项目目录"): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`${label}不存在: ${resolved}`);
  }
  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`${label}不是目录: ${resolved}`);
  }
  return resolved;
}

export function deriveProjectName(projectPath: string): string {
  return basename(resolve(projectPath)) || "未命名项目";
}

export function getThreadFileContextId(thread: Pick<AgentThreadMeta, "id" | "fileContextId">): string {
  return thread.fileContextId?.trim() || thread.id;
}

export function ensureFileContextDirs(fileContextId: string): ResolvedAgentWorkdir["filesRoot"] {
  getAgentFileContextRootPath(fileContextId);
  getAgentFileContextPlansPath(fileContextId);
  getAgentFileContextArtifactsPath(fileContextId);
  getAgentFileContextSystemContextPath(fileContextId);
  return getAgentFileContextFilesPath(fileContextId);
}

function findLegacyThreadRoot(threadId: string, workspace?: AgentWorkspace): string | null {
  const workspacesDir = getAgentWorkspacesDir();
  const slugs = workspace
    ? [workspace.slug, ...readdirSync(workspacesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== workspace.slug).map((entry) => entry.name)]
    : readdirSync(workspacesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const slug of slugs) {
    for (const candidate of [join(workspacesDir, slug, "threads", threadId), join(workspacesDir, slug, threadId)]) {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    }
  }
  return null;
}

function isEmptyContextTarget(target: string): boolean {
  if (!existsSync(target)) return true;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || !EMPTY_CONTEXT_DIRS.has(entry.name)) return false;
    if (readdirSync(join(target, entry.name)).length > 0) return false;
  }
  return true;
}

function snapshotDirectory(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else {
        const stat = statSync(path);
        files += 1;
        bytes += stat.size;
      }
    }
  }
  return { files, bytes };
}

function migrateLegacyThreadRoot(thread: AgentThreadMeta, workspace?: AgentWorkspace): string {
  const fileContextId = getThreadFileContextId(thread);
  const target = join(getAgentFileContextsDir(), fileContextId);
  const marker = join(target, MIGRATION_MARKER);
  if (existsSync(marker)) {
    recoverPostMigrationLegacyRoot(thread, workspace, target);
    return target;
  }
  const source = findLegacyThreadRoot(thread.id, workspace);
  if (!source) {
    ensureFileContextDirs(fileContextId);
    return target;
  }

  try {
    return withIndexMutationLock(`${target}.migration.lock`, () => {
      if (existsSync(marker)) return target;
      if (!isEmptyContextTarget(target)) return source;

      const staging = `${target}.migrating-${randomUUID()}`;
      try {
        cpSync(source, staging, { recursive: true, errorOnExist: true });
        const sourceSnapshot = snapshotDirectory(source);
        const stagingSnapshot = snapshotDirectory(staging);
        if (sourceSnapshot.files !== stagingSnapshot.files || sourceSnapshot.bytes !== stagingSnapshot.bytes) {
          throw new Error("旧线程工作目录迁移校验失败");
        }
        writeFileSync(join(staging, MIGRATION_MARKER), JSON.stringify({ version: 1, source, migratedAt: Date.now() }), "utf-8");
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        renameSync(staging, target);
        rmSync(source, { recursive: true, force: true });
        return target;
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    });
  } catch (error) {
    log.warn("file context migration failed; continuing with legacy directory", { error, threadId: thread.id });
    return source;
  }
}

function recoverPostMigrationLegacyRoot(
  thread: AgentThreadMeta,
  workspace: AgentWorkspace | undefined,
  target: string
): void {
  const source = findLegacyThreadRoot(thread.id, workspace);
  if (!source || resolve(source) === resolve(target)) return;

  try {
    withIndexMutationLock(`${target}.migration.lock`, () => {
      if (!existsSync(source)) return;
      const result = moveMissingLegacyEntries(source, target);
      if (result.moved > 0) {
        log.info("recovered files left in legacy thread root after migration", {
          threadId: thread.id,
          moved: result.moved
        });
      }
      if (result.conflicts > 0) {
        log.warn("legacy thread root recovery left conflicting entries in place", {
          threadId: thread.id,
          conflicts: result.conflicts
        });
      }
    });
  } catch (error) {
    log.warn("legacy thread root recovery failed", {
      threadId: thread.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function moveMissingLegacyEntries(sourceDir: string, targetDir: string): { moved: number; conflicts: number } {
  mkdirSync(targetDir, { recursive: true });
  let moved = 0;
  let conflicts = 0;

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isSymbolicLink()) {
      conflicts += 1;
      continue;
    }
    if (!existsSync(targetPath)) {
      movePathAcrossDevices(sourcePath, targetPath);
      moved += 1;
      continue;
    }
    if (entry.isDirectory() && statSync(targetPath).isDirectory()) {
      const nested = moveMissingLegacyEntries(sourcePath, targetPath);
      moved += nested.moved;
      conflicts += nested.conflicts;
      continue;
    }
    conflicts += 1;
  }

  if (readdirSync(sourceDir).length === 0) rmSync(sourceDir, { recursive: true, force: true });
  return { moved, conflicts };
}

function movePathAcrossDevices(sourcePath: string, targetPath: string): void {
  try {
    renameSync(sourcePath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(sourcePath, targetPath, { recursive: true, errorOnExist: true });
    rmSync(sourcePath, { recursive: true, force: true });
  }
}

function ensureResolvedDirs(root: string): Pick<ResolvedAgentWorkdir, "filesRoot" | "plansRoot" | "artifactsRoot"> {
  const filesRoot = join(root, "files");
  const plansRoot = join(root, "plans");
  const artifactsRoot = join(root, "artifacts");
  mkdirSync(filesRoot, { recursive: true });
  mkdirSync(plansRoot, { recursive: true });
  mkdirSync(artifactsRoot, { recursive: true });
  mkdirSync(join(root, ".context"), { recursive: true });
  return { filesRoot, plansRoot, artifactsRoot };
}

export function resolveAgentWorkdirForMeta(
  thread: AgentThreadMeta,
  workspace?: AgentWorkspace
): ResolvedAgentWorkdir {
  const fileContextId = getThreadFileContextId(thread);
  const lumeWorkDir = migrateLegacyThreadRoot(thread, workspace);
  const { filesRoot, plansRoot, artifactsRoot } = ensureResolvedDirs(lumeWorkDir);

  if (!workspace) {
    return { agentCwd: lumeWorkDir, lumeWorkDir, fileContextId, filesRoot, plansRoot, artifactsRoot };
  }

  if (!workspace.projectPath?.trim()) {
    throw new Error(`项目未绑定本地目录: ${workspace.name}`);
  }

  const projectRoot = assertExistingDirectory(workspace.projectPath);
  return {
    agentCwd: projectRoot,
    lumeWorkDir,
    projectRoot,
    fileContextId,
    filesRoot,
    plansRoot,
    artifactsRoot
  };
}

export function resolveAgentThreadWorkdir(threadId: string): ResolvedAgentWorkdir {
  const thread = threadStore().getMeta(threadId);
  if (!thread) {
    throw new Error(`Agent 线程不存在: ${threadId}`);
  }
  const workspace = thread.workspaceId ? workspaceStore().get(thread.workspaceId) : undefined;
  return resolveAgentWorkdirForMeta(thread, workspace);
}

export function resolveAgentThreadLumeWorkDir(threadId: string): string {
  const thread = threadStore().getMeta(threadId);
  if (!thread) {
    throw new Error(`Agent 线程不存在: ${threadId}`);
  }
  const workspace = thread.workspaceId ? workspaceStore().get(thread.workspaceId) : undefined;
  return migrateLegacyThreadRoot(thread, workspace);
}

export function resolveLegacyWorkspaceDirForMetadata(workspaceSlug: string): string {
  return getAgentWorkspacePath(workspaceSlug);
}
