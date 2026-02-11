import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import type {
  AgentCopyFolderInput,
  AgentSaveFilesInput,
  AgentSavedFile,
  FileEntry
} from "@lume/shared";
import { getAgentSessionWorkspacePath } from "./config-paths";

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

function resolveSessionDir(workspaceSlug: string, sessionId: string): string {
  validatePathSegment(workspaceSlug, "workspaceSlug");
  validatePathSegment(sessionId, "sessionId");
  return getAgentSessionWorkspacePath(workspaceSlug, sessionId);
}

function resolveSafeTarget(workspaceSlug: string, sessionId: string, targetPath?: string): string {
  const sessionDir = resolveSessionDir(workspaceSlug, sessionId);
  if (!targetPath || targetPath.trim().length === 0) return sessionDir;
  const resolved = resolve(targetPath);
  if (!isWithin(sessionDir, resolved)) {
    throw new Error("目标路径超出会话工作目录");
  }
  return resolved;
}

export function getAgentSessionPath(workspaceSlug: string, sessionId: string): string {
  return resolveSessionDir(workspaceSlug, sessionId);
}

export function listAgentDirectory(
  workspaceSlug: string,
  sessionId: string,
  targetPath?: string
): FileEntry[] {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
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
  workspaceSlug: string,
  sessionId: string,
  targetPath: string
): { ok: true } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  const rootPath = resolveSessionDir(workspaceSlug, sessionId);
  if (resolve(resolved) === resolve(rootPath)) {
    throw new Error("不能删除会话根目录");
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

export function openAgentPath(
  workspaceSlug: string,
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

export function showAgentPathInFolder(
  workspaceSlug: string,
  sessionId: string,
  targetPath: string
): { ok: true } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }

  if (process.platform === "win32") {
    spawnDetached("explorer", ["/select,", resolved]);
  } else if (process.platform === "darwin") {
    spawnDetached("open", ["-R", resolved]);
  } else {
    const parentPath = dirname(resolved);
    openInSystem(parentPath);
  }
  return { ok: true };
}

export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = resolveSessionDir(input.workspaceSlug, input.sessionId);
  const results: AgentSavedFile[] = [];

  for (const file of input.files) {
    const targetPath = resolve(join(sessionDir, file.filename));
    if (!isWithin(sessionDir, targetPath)) {
      throw new Error(`文件路径越界: ${file.filename}`);
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    const buffer = Buffer.from(file.data, "base64");
    writeFileSync(targetPath, buffer);
    results.push({ filename: file.filename, targetPath });
  }

  return results;
}

export function copyFolderToSession(input: AgentCopyFolderInput): AgentSavedFile[] {
  const sessionDir = resolveSessionDir(input.workspaceSlug, input.sessionId);
  const sourcePath = resolve(input.sourcePath);
  if (!existsSync(sourcePath)) {
    throw new Error("源目录不存在");
  }

  const folderName = sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? "folder";
  const targetDir = resolve(join(sessionDir, folderName));
  if (!isWithin(sessionDir, targetDir)) {
    throw new Error("目标路径越界");
  }

  cpSync(sourcePath, targetDir, { recursive: true });

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
