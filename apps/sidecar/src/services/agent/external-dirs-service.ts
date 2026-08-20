import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExternalDirEntry, ExternalDirEntryItem } from "@lume/shared";
import type { AttachmentScope } from "./agent-attachment-meta-service";
import {
  getConfigDir,
  getAgentFileContextRootPath,
} from "../infra/config-paths";
import { isPathWithinRoot } from "../agent-runtime/permissions/permission-rules";
import { createLogger } from "../infra/logger";

const log = createLogger("agent-external-dirs");

interface PersistedExternalDirRecord {
  absolutePath: string;
  attachedAt: string;
}

type PersistedExternalDirMap = Record<string, PersistedExternalDirRecord>;

class ExternalDirsReadError extends Error {
  constructor(
    message: string,
    readonly metadataPath: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "ExternalDirsReadError";
  }
}

function validatePathSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} 非法`);
  }
  return value;
}

function getWorkspaceRootPathUnsafe(workspaceSlug: string): string {
  return join(getConfigDir(), "agent-workspaces", validatePathSegment(workspaceSlug, "workspaceSlug"));
}

function getExternalDirsMetadataPath(scope: AttachmentScope): string {
  if (scope.kind === "thread" && scope.fileContextId) {
    return join(getAgentFileContextRootPath(scope.fileContextId), ".context", "external-dirs.json");
  }
  return scope.kind === "thread"
    ? join(
        getWorkspaceRootPathUnsafe(scope.workspaceSlug),
        "threads",
        validatePathSegment(scope.threadId, "threadId"),
        ".context",
        "external-dirs.json"
      )
    : join(getWorkspaceRootPathUnsafe(scope.workspaceSlug), ".meta", "external-dirs.json");
}

function readPersistedExternalDirMap(scope: AttachmentScope): PersistedExternalDirMap {
  const path = getExternalDirsMetadataPath(scope);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null) {
      throw new ExternalDirsReadError("外部目录元数据结构非法", path);
    }
    const result: PersistedExternalDirMap = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key !== "string" || typeof value !== "object" || value === null) {
        throw new ExternalDirsReadError("外部目录元数据结构非法", path);
      }
      const record = value as Partial<PersistedExternalDirRecord>;
      if (typeof record.absolutePath !== "string" || typeof record.attachedAt !== "string") {
        throw new ExternalDirsReadError("外部目录元数据结构非法", path);
      }
      result[key] = {
        absolutePath: record.absolutePath,
        attachedAt: record.attachedAt
      };
    }
    return result;
  } catch (error) {
    throw new ExternalDirsReadError("外部目录元数据损坏", path, error);
  }
}

function writePersistedExternalDirMap(scope: AttachmentScope, data: PersistedExternalDirMap): void {
  const path = getExternalDirsMetadataPath(scope);
  if (Object.keys(data).length === 0) {
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tempPath, path);
}

function toExternalDirEntry(record: PersistedExternalDirRecord): ExternalDirEntry {
  return {
    absolutePath: record.absolutePath,
    attachedAt: record.attachedAt,
    available: isPhysicalDirectory(record.absolutePath)
  };
}

function isPhysicalDirectory(absolutePath: string): boolean {
  try {
    return lstatSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function validateExternalDir(absolutePath: string): string {
  const resolved = resolve(absolutePath);
  let stats;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new Error("附加目录不存在");
  }
  if (stats.isSymbolicLink()) {
    throw new Error("不能附加符号链接目录");
  }
  if (!stats.isDirectory()) {
    throw new Error("只能附加目录");
  }
  return resolved;
}

export function listExternalDirs(scope: AttachmentScope): ExternalDirEntry[] {
  try {
    const persisted = readPersistedExternalDirMap(scope);
    return Object.values(persisted).map(toExternalDirEntry);
  } catch (error) {
    if (error instanceof ExternalDirsReadError) {
      log.warn("failed to read external dirs metadata", { metadataPath: error.metadataPath, error: error.cause ?? error });
      return [];
    }
    throw error;
  }
}

export function upsertExternalDir(scope: AttachmentScope, absolutePath: string): void {
  const key = validateExternalDir(absolutePath);
  const persisted = readPersistedExternalDirMap(scope);
  persisted[key] = {
    absolutePath: key,
    attachedAt: new Date().toISOString()
  };
  writePersistedExternalDirMap(scope, persisted);
}

export function removeExternalDir(scope: AttachmentScope, absolutePath: string): void {
  const key = resolve(absolutePath);
  const persisted = readPersistedExternalDirMap(scope);
  if (!(key in persisted)) {
    return;
  }
  delete persisted[key];
  writePersistedExternalDirMap(scope, persisted);
}

export function listExternalDirEntries(scope: AttachmentScope, absolutePath: string): ExternalDirEntryItem[] {
  const resolved = resolve(absolutePath);
  // 注册表校验：仅允许列举该 scope 已附加目录（自身或后代）内的路径，防渲染层枚举任意本机目录
  let registeredRoots: string[] = [];
  try {
    registeredRoots = Object.keys(readPersistedExternalDirMap(scope));
  } catch (error) {
    if (error instanceof ExternalDirsReadError) {
      log.warn("failed to read external dirs metadata", { metadataPath: error.metadataPath, error: error.cause ?? error });
    } else {
      throw error;
    }
  }
  if (!registeredRoots.some((root) => resolved === root || isPathWithinRoot(resolved, root))) {
    throw new Error("目录未在附加目录中，拒绝列举");
  }
  let stats;
  try {
    stats = lstatSync(resolved);
  } catch {
    throw new Error("外部目录不存在");
  }
  if (stats.isSymbolicLink()) {
    throw new Error("不能通过符号链接读取外部目录");
  }
  if (!stats.isDirectory()) {
    throw new Error("只能读取目录");
  }
  return readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry): ExternalDirEntryItem => {
      const item: ExternalDirEntryItem = {
        name: entry.name,
        isDirectory: entry.isDirectory()
      };
      try {
        const entryStats = lstatSync(join(resolved, entry.name));
        item.modifiedAt = entryStats.mtime.toISOString();
        if (entryStats.isFile()) {
          item.size = entryStats.size;
        }
      } catch {
        // 列出瞬间消失的条目只返回名称与类型
      }
      return item;
    });
}
