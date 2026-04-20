import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExternalAttachmentMeta } from "@lume/shared";
import {
  getConfigDir,
} from "../infra/config-paths";

interface PersistedAttachmentRecord {
  absoluteSourcePath: string;
  attachedAt: number;
}

export interface ThreadAttachmentScope {
  kind: "thread";
  workspaceSlug: string;
  threadId: string;
}

export interface WorkspaceAttachmentScope {
  kind: "workspace";
  workspaceSlug: string;
}

export type AttachmentScope = ThreadAttachmentScope | WorkspaceAttachmentScope;

type PersistedAttachmentMap = Record<string, PersistedAttachmentRecord>;

class AttachmentMetadataReadError extends Error {
  constructor(
    message: string,
    readonly metadataPath: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "AttachmentMetadataReadError";
  }
}

function validatePathSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`${label} 非法`);
  }
  return value;
}

function isWithin(basePath: string, targetPath: string): boolean {
  const base = resolve(basePath);
  const target = resolve(targetPath);
  if (process.platform === "win32") {
    const b = base.toLowerCase();
    const t = target.toLowerCase();
    return t === b || t.startsWith(`${b}\\`);
  }
  return target === base || target.startsWith(`${base}/`);
}

function getWorkspaceRootPathUnsafe(workspaceSlug: string): string {
  return join(getConfigDir(), "agent-workspaces", validatePathSegment(workspaceSlug, "workspaceSlug"));
}

function getScopeRoot(scope: AttachmentScope): string {
  return scope.kind === "thread"
    ? join(
        getWorkspaceRootPathUnsafe(scope.workspaceSlug),
        "threads",
        validatePathSegment(scope.threadId, "threadId"),
        "files"
      )
    : join(getWorkspaceRootPathUnsafe(scope.workspaceSlug), "resources");
}

function getMetadataPath(scope: AttachmentScope): string {
  return scope.kind === "thread"
    ? join(
        getWorkspaceRootPathUnsafe(scope.workspaceSlug),
        "threads",
        validatePathSegment(scope.threadId, "threadId"),
        ".context",
        "external-attachments.json"
      )
    : join(getWorkspaceRootPathUnsafe(scope.workspaceSlug), ".meta", "external-attachments.json");
}

function normalizeRelativeTarget(scope: AttachmentScope, targetPath: string): string {
  const root = getScopeRoot(scope);
  const resolvedTarget = resolve(targetPath);
  if (!isWithin(root, resolvedTarget)) {
    throw new Error("目标路径超出附件元信息作用域");
  }
  const rel = relative(root, resolvedTarget).split(sep).join("/");
  if (!rel || rel === ".") {
    throw new Error("不能对作用域根目录记录附件元信息");
  }
  return rel;
}

function readPersistedAttachmentMap(scope: AttachmentScope): PersistedAttachmentMap {
  const path = getMetadataPath(scope);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null) {
      return {};
    }
    const result: PersistedAttachmentMap = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key !== "string" || typeof value !== "object" || value === null) {
        continue;
      }
      const record = value as Partial<PersistedAttachmentRecord>;
      if (typeof record.absoluteSourcePath !== "string") {
        continue;
      }
      result[key] = {
        absoluteSourcePath: record.absoluteSourcePath,
        attachedAt: typeof record.attachedAt === "number" ? record.attachedAt : 0
      };
    }
    return result;
  } catch (error) {
    throw new AttachmentMetadataReadError("附件元信息损坏", path, error);
  }
}

function writePersistedAttachmentMap(scope: AttachmentScope, data: PersistedAttachmentMap): void {
  const path = getMetadataPath(scope);
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tempPath, path);
}

function toExternalAttachmentMeta(record: PersistedAttachmentRecord): ExternalAttachmentMeta {
  return {
    label: "外部附加",
    absoluteSourcePath: record.absoluteSourcePath
  };
}

export function readThreadAttachmentMeta(workspaceSlug: string, threadId: string): Record<string, ExternalAttachmentMeta> {
  try {
    const persisted = readPersistedAttachmentMap({ kind: "thread", workspaceSlug, threadId });
    return Object.fromEntries(
      Object.entries(persisted).map(([key, value]) => [key, toExternalAttachmentMeta(value)])
    );
  } catch (error) {
    if (error instanceof AttachmentMetadataReadError) {
      console.warn("[Attachment Meta] 读取线程附件元信息失败:", error.cause ?? error);
      return {};
    }
    throw error;
  }
}

export function readWorkspaceAttachmentMeta(workspaceSlug: string): Record<string, ExternalAttachmentMeta> {
  try {
    const persisted = readPersistedAttachmentMap({ kind: "workspace", workspaceSlug });
    return Object.fromEntries(
      Object.entries(persisted).map(([key, value]) => [key, toExternalAttachmentMeta(value)])
    );
  } catch (error) {
    if (error instanceof AttachmentMetadataReadError) {
      console.warn("[Attachment Meta] 读取工作区附件元信息失败:", error.cause ?? error);
      return {};
    }
    throw error;
  }
}

export function upsertAttachmentMeta(
  scope: AttachmentScope,
  targetPath: string,
  meta: ExternalAttachmentMeta
): void {
  const key = normalizeRelativeTarget(scope, targetPath);
  const persisted = readPersistedAttachmentMap(scope);
  persisted[key] = {
    absoluteSourcePath: meta.absoluteSourcePath,
    attachedAt: Date.now()
  };
  writePersistedAttachmentMap(scope, persisted);
}

export function moveAttachmentMeta(scope: AttachmentScope, fromPath: string, toPath: string): void {
  const fromKey = normalizeRelativeTarget(scope, fromPath);
  const toKey = normalizeRelativeTarget(scope, toPath);
  const persisted = readPersistedAttachmentMap(scope);
  const next: PersistedAttachmentMap = {};

  for (const [key, value] of Object.entries(persisted)) {
    if (key === fromKey || key.startsWith(`${fromKey}/`)) {
      const suffix = key.slice(fromKey.length);
      next[`${toKey}${suffix}`] = value;
      continue;
    }
    next[key] = value;
  }

  writePersistedAttachmentMap(scope, next);
}

export function deleteAttachmentMeta(scope: AttachmentScope, targetPath: string): void {
  const key = normalizeRelativeTarget(scope, targetPath);
  const persisted = readPersistedAttachmentMap(scope);
  const next = Object.fromEntries(
    Object.entries(persisted).filter(([entryKey]) => entryKey !== key && !entryKey.startsWith(`${key}/`))
  );
  writePersistedAttachmentMap(scope, next);
}

export function getAttachmentMeta(scope: AttachmentScope, targetPath: string): ExternalAttachmentMeta | undefined {
  try {
    const key = normalizeRelativeTarget(scope, targetPath);
    const persisted = readPersistedAttachmentMap(scope);
    const record = persisted[key];
    return record ? toExternalAttachmentMeta(record) : undefined;
  } catch (error) {
    if (error instanceof AttachmentMetadataReadError) {
      console.warn("[Attachment Meta] 查询附件元信息失败:", error.cause ?? error);
      return undefined;
    }
    throw error;
  }
}
