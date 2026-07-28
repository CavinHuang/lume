import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimeCodingChangeSet, RuntimeCodingFileChange, RuntimeCodingRepository } from "@lume/shared";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

export interface CodingFileDiff {
  rootId?: string;
  path: string;
  status: RuntimeCodingFileChange["status"];
  oldContent: string;
  newContent: string;
  lines: CodingDiffLine[];
  addedLines: number;
  removedLines: number;
}

export interface CodingDiffLine {
  type: "context" | "added" | "removed";
  oldLine?: number;
  newLine?: number;
  text: string;
}

interface GitFileEntry {
  path: string;
  status: RuntimeCodingFileChange["status"];
  addedLines: number;
  removedLines: number;
}

export async function getCodingChangeSet(
  workspaceRoot: string,
  options: { paths?: Iterable<string>; turnId?: string; roots?: Iterable<string> } = {}
): Promise<RuntimeCodingChangeSet> {
  const roots = await discoverCodingRoots([workspaceRoot, ...(options.roots ?? [])]);
  if (roots.length === 1) {
    const single = await getSingleCodingChangeSet(roots[0]!.path, options);
    return {
      ...single,
      repositories: [roots[0]!.repository],
      files: single.files.map((file) => ({ ...file, rootId: roots[0]!.repository.rootId }))
    };
  }
  const changeSets = await Promise.all(roots.map(async (root) => ({
    root,
    changeSet: await getSingleCodingChangeSet(root.path, options)
  })));
  const files = changeSets.flatMap(({ root, changeSet }) =>
    changeSet.files.map((file) => ({ ...file, rootId: root.repository.rootId }))
  );
  const repositories = changeSets.map(({ root, changeSet }) => ({
    ...root.repository,
    ...(changeSet.branch ? { branch: changeSet.branch } : {})
  }));
  return {
    ...(options.turnId ? { turnId: options.turnId } : {}),
    repositories,
    ...(repositories.length === 1 && repositories[0]?.branch ? { branch: repositories[0].branch } : {}),
    base: repositories.every((repository) => repository.kind === "git") ? "git_head" : "workspace_snapshot",
    isGitRepo: repositories.some((repository) => repository.kind === "git"),
    files: files.sort((a, b) => `${a.rootId}:${a.path}`.localeCompare(`${b.rootId}:${b.path}`)),
    totalAddedLines: files.reduce((sum, file) => sum + (file.addedLines ?? 0), 0),
    totalRemovedLines: files.reduce((sum, file) => sum + (file.removedLines ?? 0), 0),
    generatedAt: new Date().toISOString()
  };
}

async function getSingleCodingChangeSet(
  workspaceRoot: string,
  options: { paths?: Iterable<string>; turnId?: string } = {}
): Promise<RuntimeCodingChangeSet> {
  const root = resolve(workspaceRoot);
  const gitRoot = await findGitRoot(root);
  if (!gitRoot) {
    const files = await getSnapshotFileChanges(root, options.paths);
    return {
      ...(options.turnId ? { turnId: options.turnId } : {}),
      base: "workspace_snapshot",
      isGitRepo: false,
      files,
      totalAddedLines: files.reduce((sum, file) => sum + (file.addedLines ?? 0), 0),
      totalRemovedLines: files.reduce((sum, file) => sum + (file.removedLines ?? 0), 0),
      generatedAt: new Date().toISOString(),
    };
  }

  const allowedPaths = normalizePathFilter(gitRoot, options.paths);
  const tracked = parseNumstat(await runGitCommand(["diff", "HEAD", "--numstat", "--find-renames", "-z"], gitRoot));
  const statuses = parseStatuses(await runGitCommand(["diff", "HEAD", "--name-status", "--find-renames", "-z"], gitRoot));
  const untracked = parseNulPaths(await runGitCommand(["ls-files", "--others", "--exclude-standard", "-z"], gitRoot));
  const byPath = new Map<string, GitFileEntry>();

  for (const entry of statuses) {
    if (allowedPaths && !allowedPaths.has(entry.path)) continue;
    const stats = tracked.get(entry.path) ?? { addedLines: 0, removedLines: 0 };
    byPath.set(entry.path, {
      path: entry.path,
      status: entry.status,
      ...stats,
    });
  }
  for (const path of untracked) {
    if (allowedPaths && !allowedPaths.has(path)) continue;
    let addedLines = 0;
    try {
      addedLines = countLines(readSafeContent(gitRoot, path));
    } catch {
      // Keep the file visible while avoiding a large/binary file breaking the Run report.
    }
    byPath.set(path, {
      path,
      status: "untracked",
      addedLines,
      removedLines: 0,
    });
  }

  const files: RuntimeCodingFileChange[] = await Promise.all([...byPath.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(async (file) => ({
      path: file.path,
      status: file.status,
      addedLines: file.addedLines,
      removedLines: file.removedLines,
      source: "git",
      canUndo: true,
      newContentAvailable: await isPreviewableFile(gitRoot, file.path),
      oldContentAvailable: file.status === "untracked" || file.status === "added" ? false : true,
      state: "normal" as const,
    })));
  const branch = await getGitBranchInfo(gitRoot);
  return {
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(branch ? { branch } : {}),
    base: "git:HEAD",
    isGitRepo: true,
    files,
    totalAddedLines: files.reduce((sum, file) => sum + (file.addedLines ?? 0), 0),
    totalRemovedLines: files.reduce((sum, file) => sum + (file.removedLines ?? 0), 0),
    generatedAt: new Date().toISOString(),
  };
}

async function getGitBranchInfo(gitRoot: string): Promise<{ name: string; upstream?: string } | undefined> {
  const name = (await runGitCommand(["branch", "--show-current"], gitRoot))?.trim();
  if (!name) return undefined;
  const upstream = (await runGitCommand(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], gitRoot))?.trim();
  return {
    name,
    ...(upstream ? { upstream } : {}),
  };
}

export async function getCodingFileDiff(
  workspaceRoot: string,
  filePath: string,
  options: { rootId?: string; roots?: Iterable<string> } = {}
): Promise<CodingFileDiff> {
  const discoveredRoots = await discoverCodingRoots([workspaceRoot, ...(options.roots ?? [])]);
  const selectedRoot = options.rootId
    ? discoveredRoots.find((candidate) => candidate.repository.rootId === options.rootId)
    : discoveredRoots[0];
  if (!selectedRoot) throw new Error(`找不到 Coding 根目录: ${options.rootId ?? workspaceRoot}`);
  const root = selectedRoot.path;
  const gitRoot = await findGitRoot(root);
  if (!gitRoot) {
    const safePath = normalizeSafePath(root, filePath);
    if (!safePath) throw new Error("文件路径超出项目目录");
    const newContent = readSafeContent(root, safePath);
    return {
      rootId: selectedRoot.repository.rootId,
      path: safePath,
      status: "modified",
      oldContent: "",
      newContent,
      lines: createAddedLines(newContent, "added"),
      addedLines: countLines(newContent),
      removedLines: 0,
    };
  }
  const safePath = normalizeSafePath(gitRoot, filePath);
  if (!safePath) throw new Error("文件路径超出项目目录");

  const changeSet = await getSingleCodingChangeSet(gitRoot, { paths: [safePath] });
  const file = changeSet.files[0];
  if (!file) throw new Error("文件当前没有可审核的变更");
  const oldContent = file.status === "untracked" || file.status === "added" ? "" : await readGitContent(gitRoot, safePath);
  const newContent = file.status === "deleted" ? "" : readSafeContent(gitRoot, safePath);
  const gitDiff = await runGitCommand(["diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--", safePath], gitRoot);
  return {
    rootId: selectedRoot.repository.rootId,
    path: safePath,
    status: file.status,
    oldContent,
    newContent,
    lines: gitDiff ? parseUnifiedDiff(gitDiff) : createAddedLines(newContent, file.status),
    addedLines: file.addedLines ?? 0,
    removedLines: file.removedLines ?? 0,
  };
}

export async function discoverCodingRoots(
  roots: Iterable<string>
): Promise<Array<{ path: string; repository: RuntimeCodingRepository }>> {
  const discovered = new Map<string, { path: string; repository: RuntimeCodingRepository }>();
  for (const rawRoot of roots) {
    const resolvedRoot = resolve(rawRoot);
    if (!existsSync(resolvedRoot)) continue;
    let realRoot: string;
    try {
      realRoot = realpathSync(resolvedRoot);
    } catch {
      realRoot = resolvedRoot;
    }
    const gitRoot = await findGitRoot(realRoot);
    const path = gitRoot ?? realRoot;
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (discovered.has(key)) continue;
    const branch = gitRoot ? await getGitBranchInfo(path) : undefined;
    discovered.set(key, {
      path,
      repository: {
        rootId: rootIdForPath(path),
        rootLabel: basename(path),
        kind: gitRoot ? "git" : "snapshot",
        base: gitRoot ? "git:HEAD" : "workspace_snapshot",
        ...(branch ? { branch } : {})
      }
    });
  }
  return [...discovered.values()];
}

function rootIdForPath(path: string): string {
  const normalized = process.platform === "win32" ? path.toLowerCase() : path;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function parseUnifiedDiff(output: string): CodingDiffLine[] {
  const lines: CodingDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of normalizeLineEndings(output).split("\n")) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk || rawLine === "\\ No newline at end of file") continue;

    const marker = rawLine[0];
    if (marker !== " " && marker !== "+" && marker !== "-") continue;
    const text = rawLine.slice(1);
    if (marker === " ") {
      lines.push({ type: "context", oldLine, newLine, text });
      oldLine += 1;
      newLine += 1;
    } else if (marker === "+") {
      lines.push({ type: "added", newLine, text });
      newLine += 1;
    } else if (marker === "-") {
      lines.push({ type: "removed", oldLine, text });
      oldLine += 1;
    }
  }
  return lines;
}

export function createContentDiffLines(oldContent: string, newContent: string): CodingDiffLine[] {
  const oldLines = splitContentLines(oldContent);
  const newLines = splitContentLines(newContent);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const lines: CodingDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    lines.push({ type: "context", oldLine: index + 1, newLine: index + 1, text: oldLines[index] ?? "" });
  }
  for (let index = prefix; index < oldLines.length - suffix; index += 1) {
    lines.push({ type: "removed", oldLine: index + 1, text: oldLines[index] ?? "" });
  }
  for (let index = prefix; index < newLines.length - suffix; index += 1) {
    lines.push({ type: "added", newLine: index + 1, text: newLines[index] ?? "" });
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    const oldIndex = oldLines.length - offset;
    const newIndex = newLines.length - offset;
    lines.push({
      type: "context",
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
      text: oldLines[oldIndex] ?? "",
    });
  }
  return lines;
}

function createAddedLines(content: string, status: RuntimeCodingFileChange["status"]): CodingDiffLine[] {
  if (status !== "untracked" && status !== "added") return [];
  const sourceLines = content ? content.split("\n") : [];
  if (content.endsWith("\n")) sourceLines.pop();
  return sourceLines.map((text, index) => ({ type: "added", newLine: index + 1, text }));
}

function splitContentLines(content: string): string[] {
  if (!content) return [];
  const lines = normalizeLineEndings(content).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function findGitRoot(start: string): Promise<string | null> {
  let candidate = resolve(start);
  while (true) {
    if (existsSync(resolve(candidate, ".git"))) break;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  const output = await runGitCommand(["rev-parse", "--show-toplevel"], candidate);
  if (!output) return null;
  const trimmed = output.trim();
  try {
    return realpathSync(trimmed);
  } catch {
    return resolve(trimmed);
  }
}

function parseStatuses(output: string | null): Array<{ path: string; status: GitFileEntry["status"] }> {
  if (!output) return [];
  const parts = output.split("\0").filter(Boolean);
  const entries: Array<{ path: string; status: GitFileEntry["status"] }> = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index]?.[0];
    const rawPath = parts[index + 1];
    if (status === "R" && parts[index + 2]) {
      entries.push({ path: parts[index + 2]!, status: "renamed" });
      index += 3;
      continue;
    }
    const path = rawPath;
    if (!path) {
      index += 2;
      continue;
    }
    if (status === "D") entries.push({ path, status: "deleted" });
    else if (status === "A") entries.push({ path, status: "added" });
    else entries.push({ path, status: "modified" });
    index += 2;
  }
  return entries;
}

function parseNumstat(output: string | null): Map<string, { addedLines: number; removedLines: number }> {
  const result = new Map<string, { addedLines: number; removedLines: number }>();
  if (!output) return result;
  const parts = output.split("\0").filter(Boolean);
  for (const part of parts) {
    const fields = part.split("\t");
    if (fields.length < 3) continue;
    result.set(fields.slice(2).join("\t"), {
      addedLines: Number.isFinite(Number(fields[0])) ? Math.max(0, Number(fields[0])) : 0,
      removedLines: Number.isFinite(Number(fields[1])) ? Math.max(0, Number(fields[1])) : 0,
    });
  }
  return result;
}

function parseNulPaths(output: string | null): string[] {
  return output ? output.split("\0").filter(Boolean) : [];
}

function normalizePathFilter(root: string, paths?: Iterable<string>): Set<string> | undefined {
  if (!paths) return undefined;
  const result = new Set<string>();
  for (const path of paths) {
    const safe = normalizeSafePath(root, path);
    if (safe) result.add(safe);
  }
  return result;
}

async function getSnapshotFileChanges(
  root: string,
  paths?: Iterable<string>,
): Promise<RuntimeCodingFileChange[]> {
  if (!paths) return [];
  const files: RuntimeCodingFileChange[] = [];
  for (const rawPath of paths) {
    const path = normalizeSafePath(root, rawPath);
    if (!path) continue;
    const absolute = resolve(root, path);
    const exists = existsSync(absolute) && statSync(absolute).isFile();
    const previewable = exists && await isPreviewableFile(root, path);
    const content = exists && previewable ? readSafeContent(root, path) : "";
    files.push({
      path,
      status: exists ? "modified" : "deleted",
      addedLines: exists ? countLines(content) : 0,
      removedLines: 0,
      source: "snapshot",
      canUndo: false,
      oldContentAvailable: false,
      newContentAvailable: previewable,
      state: previewable ? "normal" : "unpreviewable",
    });
  }
  return files;
}

function normalizeSafePath(root: string, filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") return null;
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(resolve(root));
  } catch {
    resolvedRoot = resolve(root);
  }
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(resolvedRoot, filePath);
  if (filePath.split(/[\\/]/).includes("..")) return null;
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    try {
      realTarget = resolve(realpathSync(dirname(target)), basename(target));
    } catch {
      realTarget = target;
    }
  }
  const relativeRealPath = relative(resolvedRoot, realTarget).split(sep).join("/");
  if (!relativeRealPath || relativeRealPath === ".." || relativeRealPath.startsWith("../")) return null;
  return relative(resolvedRoot, target).split(sep).join("/");
}

function readSafeContent(root: string, filePath: string): string {
  const safePath = normalizeSafePath(root, filePath);
  if (!safePath) throw new Error("文件路径超出项目目录");
  const target = resolve(root, safePath);
  if (!existsSync(target) || !statSync(target).isFile()) return "";
  if (statSync(target).size > MAX_FILE_SIZE_BYTES) throw new Error("文件过大，无法生成 diff");
  return normalizeLineEndings(readFileSync(target, "utf-8"));
}

async function isPreviewableFile(root: string, filePath: string): Promise<boolean> {
  const safePath = normalizeSafePath(root, filePath);
  if (!safePath) return false;
  try {
    const target = resolve(root, safePath);
    const metadata = statSync(target);
    if (!metadata.isFile() || metadata.size > MAX_FILE_SIZE_BYTES) return false;
    return !readFileSync(target).subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
}

async function readGitContent(root: string, filePath: string): Promise<string> {
  const result = await runGitCommand(["show", `HEAD:${filePath}`], root);
  if (result === null) return "";
  if (Buffer.byteLength(result, "utf-8") > MAX_FILE_SIZE_BYTES) throw new Error("文件过大，无法生成 diff");
  return normalizeLineEndings(result);
}

function countLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n");
  return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function runGitCommand(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };
    let child;
    try {
      child = spawn("git", ["-c", "core.quotePath=false", ...args], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch {
      finish(null);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    let stdout = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, GIT_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timeout);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      finish(code === 0 ? stdout : null);
    });
  });
}
