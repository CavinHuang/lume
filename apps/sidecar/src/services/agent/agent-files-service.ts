import {
  cpSync,
  copyFileSync,
  existsSync,
  type Dirent,
  renameSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  AgentCopyFolderInput,
  AgentSaveFilesInput,
  AgentSavedFile,
  FileEntry,
  FileSearchResult,
  PlanFileMeta
} from "@lume/shared";
import { getAgentSessionWorkspacePath, getAgentWorkspacesDir } from "../infra/config-paths";

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

export function resolveWorkspaceSlugBySessionId(sessionId: string): string | null {
  validatePathSegment(sessionId, "sessionId");
  const workspacesDir = getAgentWorkspacesDir();
  if (!existsSync(workspacesDir)) return null;
  for (const entry of readdirSync(workspacesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(workspacesDir, entry.name, sessionId);
    if (!existsSync(candidate)) continue;
    return entry.name;
  }
  return null;
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

function resolveAttachedTarget(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    throw new Error("缺少目标路径");
  }
  return resolve(trimmed);
}

function resolveSessionPlansDir(workspaceSlug: string, sessionId: string): string {
  return join(resolveSessionDir(workspaceSlug, sessionId), "plans");
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

function parsePlanSummary(content: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match || !match[1]) return undefined;
  const line = match[1]
    .split("\n")
    .find((item) => item.trim().startsWith("summary:"));
  if (!line) return undefined;
  const value = line.slice(line.indexOf(":") + 1).trim();
  if (!value) return undefined;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim() || undefined;
  }
  return value;
}

function resolveSafePlanPath(
  workspaceSlug: string,
  sessionId: string,
  planPath: string
): string {
  if (!planPath || !planPath.trim()) {
    throw new Error("缺少 planPath");
  }
  const plansDir = resolveSessionPlansDir(workspaceSlug, sessionId);
  const directResolved = resolve(planPath);
  const filenameResolved = resolve(join(plansDir, planPath));
  const resolvedCandidate = isWithin(plansDir, directResolved) ? directResolved : filenameResolved;
  if (!isWithin(plansDir, resolvedCandidate)) {
    throw new Error("Plan 路径超出会话 plans 目录");
  }
  return resolvedCandidate;
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

export function renameAgentFile(
  workspaceSlug: string,
  sessionId: string,
  targetPath: string,
  newName: string
): { ok: true; path: string } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  const rootPath = resolveSessionDir(workspaceSlug, sessionId);
  if (resolve(resolved) === resolve(rootPath)) {
    throw new Error("不能重命名会话根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  const safeName = validateNewName(newName);
  const nextPath = join(dirname(resolved), safeName);
  if (!isWithin(rootPath, nextPath)) {
    throw new Error("重命名后路径超出会话工作目录");
  }
  if (existsSync(nextPath)) {
    throw new Error("目标名称已存在");
  }
  movePathWithFallback(resolved, nextPath);
  return { ok: true, path: nextPath };
}

export function moveAgentFile(
  workspaceSlug: string,
  sessionId: string,
  targetPath: string,
  targetDir: string
): { ok: true; path: string } {
  const resolved = resolveSafeTarget(workspaceSlug, sessionId, targetPath);
  const rootPath = resolveSessionDir(workspaceSlug, sessionId);
  const resolvedTargetDir = resolveSafeTarget(workspaceSlug, sessionId, targetDir);

  if (resolve(resolved) === resolve(rootPath)) {
    throw new Error("不能移动会话根目录");
  }
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  if (!existsSync(resolvedTargetDir) || !statSync(resolvedTargetDir).isDirectory()) {
    throw new Error("目标目录不存在");
  }

  const nextPath = join(resolvedTargetDir, basename(resolved));
  if (!isWithin(rootPath, nextPath)) {
    throw new Error("移动后路径超出会话工作目录");
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

export function previewAgentPath(
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

export function listAttachedDirectory(path: string): FileEntry[] {
  const resolved = resolveAttachedTarget(path);
  if (!existsSync(resolved)) {
    return [];
  }
  const directoryStat = statSync(resolved);
  if (!directoryStat.isDirectory()) {
    throw new Error("附加目录不存在");
  }
  const items = readdirSync(resolved, { withFileTypes: true })
    .filter((item) => !item.name.startsWith("."))
    .map((item) => ({
      name: item.name,
      path: join(resolved, item.name),
      isDirectory: item.isDirectory()
    } satisfies FileEntry));

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, "en");
  });
  return items;
}

export function openAttachedPath(targetPath: string): { ok: true } {
  const resolved = resolveAttachedTarget(targetPath);
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  openInSystem(resolved);
  return { ok: true };
}

export function showAttachedPathInFolder(targetPath: string): { ok: true } {
  const resolved = resolveAttachedTarget(targetPath);
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  showInSystemFolder(resolved);
  return { ok: true };
}

export function renameAttachedPath(targetPath: string, newName: string): { ok: true; path: string } {
  const resolved = resolveAttachedTarget(targetPath);
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  const safeName = validateNewName(newName);
  const nextPath = join(dirname(resolved), safeName);
  if (existsSync(nextPath)) {
    throw new Error("目标名称已存在");
  }
  movePathWithFallback(resolved, nextPath);
  return { ok: true, path: nextPath };
}

export function moveAttachedPath(targetPath: string, targetDir: string): { ok: true; path: string } {
  const resolved = resolveAttachedTarget(targetPath);
  const resolvedTargetDir = resolveAttachedTarget(targetDir);
  if (!existsSync(resolved)) {
    throw new Error("目标不存在");
  }
  if (!existsSync(resolvedTargetDir) || !statSync(resolvedTargetDir).isDirectory()) {
    throw new Error("目标目录不存在");
  }
  const nextPath = join(resolvedTargetDir, basename(resolved));
  if (resolve(nextPath) === resolve(resolved)) {
    return { ok: true, path: nextPath };
  }
  if (existsSync(nextPath)) {
    throw new Error("目标路径已存在同名文件");
  }
  movePathWithFallback(resolved, nextPath);
  return { ok: true, path: nextPath };
}

export function listAgentPlans(workspaceSlug: string, sessionId: string): PlanFileMeta[] {
  const plansDir = resolveSessionPlansDir(workspaceSlug, sessionId);
  if (!existsSync(plansDir)) return [];

  const plans = readdirSync(plansDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => {
      const planPath = join(plansDir, entry.name);
      const stat = statSync(planPath);
      let summary: string | undefined;
      try {
        summary = parsePlanSummary(readFileSync(planPath, "utf-8"));
      } catch {
        summary = undefined;
      }
      return {
        name: entry.name,
        path: planPath,
        createdAt: stat.birthtimeMs || stat.mtimeMs,
        size: stat.size,
        summary
      } satisfies PlanFileMeta;
    });

  plans.sort((a, b) => b.createdAt - a.createdAt);
  return plans;
}

export function readAgentPlan(
  workspaceSlug: string,
  sessionId: string,
  planPath: string
): { path: string; content: string } {
  const resolvedPlanPath = resolveSafePlanPath(workspaceSlug, sessionId, planPath);
  if (!existsSync(resolvedPlanPath)) {
    throw new Error("Plan 文件不存在");
  }
  return {
    path: resolvedPlanPath,
    content: readFileSync(resolvedPlanPath, "utf-8")
  };
}

export function deleteAgentPlan(
  workspaceSlug: string,
  sessionId: string,
  planPath: string
): { ok: true } {
  const resolvedPlanPath = resolveSafePlanPath(workspaceSlug, sessionId, planPath);
  if (!existsSync(resolvedPlanPath)) return { ok: true };
  rmSync(resolvedPlanPath, { force: true });
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
