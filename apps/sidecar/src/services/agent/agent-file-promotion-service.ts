import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { PromoteFileToWorkspaceInput, PromoteFileToWorkspaceResult } from "@lume/shared";
import {
  getAgentSessionWorkspacePath,
  getAgentThreadFilesPath,
  getWorkspaceResourcesPath
} from "../infra/config-paths";
import {
  getAttachmentMeta,
  upsertAttachmentMeta
} from "./agent-attachment-meta-service";

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

function resolveConflictPath(targetPath: string): string {
  const ext = extname(targetPath);
  const stem = ext ? targetPath.slice(0, -ext.length) : targetPath;
  let index = 1;
  let candidate = `${stem}-${index}${ext}`;
  while (existsSync(candidate)) {
    index += 1;
    candidate = `${stem}-${index}${ext}`;
  }
  return candidate;
}

export function promoteFileToWorkspace(
  input: PromoteFileToWorkspaceInput
): PromoteFileToWorkspaceResult {
  const threadFilesRoot = getAgentThreadFilesPath(input.workspaceSlug, input.threadId);
  const threadRoot = getAgentSessionWorkspacePath(input.workspaceSlug, input.threadId);
  const sourcePath = resolve(input.filePath);
  if (!isWithin(threadFilesRoot, sourcePath) && !isWithin(threadRoot, sourcePath)) {
    throw new Error("只能提升当前任务文件层中的文件");
  }
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error("待提升文件不存在");
  }

  const resourcesRoot = getWorkspaceResourcesPath(input.workspaceSlug);
  let targetPath = join(resourcesRoot, basename(sourcePath));
  if (existsSync(targetPath)) {
    if (input.conflictMode === "overwrite") {
      // keep targetPath as is
    } else if (input.conflictMode === "rename") {
      targetPath = resolveConflictPath(targetPath);
    } else {
      throw new Error("同名文件已存在");
    }
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  const sourceMeta = getAttachmentMeta(
    { kind: "thread", workspaceSlug: input.workspaceSlug, threadId: input.threadId },
    sourcePath
  );
  if (sourceMeta) {
    upsertAttachmentMeta(
      { kind: "workspace", workspaceSlug: input.workspaceSlug },
      targetPath,
      sourceMeta
    );
  }
  return { ok: true, path: targetPath };
}
