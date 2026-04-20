import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExternalAttachmentMeta } from "@lume/shared";
import {
  getAgentThreadFilesPath,
  getAgentThreadSystemContextPath,
  getWorkspaceMetaPath,
  getWorkspaceResourcesPath
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

function getScopeRoot(scope: AttachmentScope): string {
  return scope.kind === "thread"
    ? getAgentThreadFilesPath(scope.workspaceSlug, scope.threadId)
    : getWorkspaceResourcesPath(scope.workspaceSlug);
}

function getMetadataPath(scope: AttachmentScope): string {
  return scope.kind === "thread"
    ? join(getAgentThreadSystemContextPath(scope.workspaceSlug, scope.threadId), "external-attachments.json")
    : join(getWorkspaceMetaPath(scope.workspaceSlug), "external-attachments.json");
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
  } catch {
    return {};
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
  const persisted = readPersistedAttachmentMap({ kind: "thread", workspaceSlug, threadId });
  return Object.fromEntries(
    Object.entries(persisted).map(([key, value]) => [key, toExternalAttachmentMeta(value)])
  );
}

export function readWorkspaceAttachmentMeta(workspaceSlug: string): Record<string, ExternalAttachmentMeta> {
  const persisted = readPersistedAttachmentMap({ kind: "workspace", workspaceSlug });
  return Object.fromEntries(
    Object.entries(persisted).map(([key, value]) => [key, toExternalAttachmentMeta(value)])
  );
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
  const key = normalizeRelativeTarget(scope, targetPath);
  const persisted = readPersistedAttachmentMap(scope);
  const record = persisted[key];
  return record ? toExternalAttachmentMeta(record) : undefined;
}
