import { lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { rewindCheckpoint, type FileCheckpoint } from "@lume/agent-sdk";

const CHECKPOINT_FILE_PREFIX = "coding-checkpoint-";

export interface CodingRunCheckpointRecord {
  runId: string;
  cwd: string;
  roots?: string[];
  baselineCommit?: string;
  after?: Record<string, CodingFileFingerprint>;
  checkpoint: FileCheckpoint;
  createdAt: string;
}

export interface CodingFileFingerprint {
  exists: boolean;
  size?: number;
  hash?: string;
}

function checkpointFileName(runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${CHECKPOINT_FILE_PREFIX}${safeRunId}.json`;
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function restrictCheckpointToRoots(roots: string[], checkpoint: FileCheckpoint): FileCheckpoint {
  const files = Object.fromEntries(
    Object.entries(checkpoint.files).filter(([path]) => roots.some((root) => isPathInside(root, path))),
  );
  return { ...checkpoint, files };
}

async function assertNoSymlinkPath(root: string, path: string): Promise<void> {
  if (!isPathInside(root, path)) throw new Error(`拒绝恢复工作区外的文件: ${path}`);
  let current = resolve(path);
  const resolvedRoot = resolve(root);
  while (isPathInside(resolvedRoot, current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`拒绝恢复符号链接路径: ${path}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("拒绝恢复")) throw error;
      // Missing files are valid for snapshots of files created during the Run.
    }
    if (current === resolvedRoot) break;
    current = dirname(current);
  }
}

export async function persistCodingRunCheckpoint(input: {
  sessionDir: string;
  runId: string;
  cwd: string;
  roots?: string[];
  baselineCommit?: string;
  changedPaths?: string[];
  checkpoint?: FileCheckpoint;
}): Promise<boolean> {
  const sourceCheckpoint = input.checkpoint ?? {
    userMessageId: input.runId,
    createdAt: new Date().toISOString(),
    files: {}
  } satisfies FileCheckpoint;
  const roots = [...new Set([input.cwd, ...(input.roots ?? [])].map((root) => resolve(root)))];
  const checkpoint = restrictCheckpointToRoots(roots, sourceCheckpoint);
  for (const changedPath of input.changedPaths ?? []) {
    const absolute = resolve(input.cwd, changedPath);
    if (!roots.some((root) => isPathInside(root, absolute))) continue;
    if (!checkpoint.files[absolute]) checkpoint.files[absolute] = { path: absolute, existed: false };
  }
  if (Object.keys(checkpoint.files).length === 0) return false;

  const record: CodingRunCheckpointRecord = {
    runId: input.runId,
    cwd: resolve(input.cwd),
    roots,
    baselineCommit: input.baselineCommit,
    after: await captureFingerprints(Object.keys(checkpoint.files)),
    checkpoint,
    createdAt: new Date().toISOString(),
  };
  await mkdir(input.sessionDir, { recursive: true });
  const path = resolve(input.sessionDir, checkpointFileName(input.runId));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), "utf8");
  await rename(temporary, path);
  return true;
}

async function captureFingerprints(paths: string[]): Promise<Record<string, CodingFileFingerprint>> {
  const result: Record<string, CodingFileFingerprint> = {};
  for (const path of paths) {
    try {
      const [metadata, content] = await Promise.all([stat(path), readFile(path)]);
      result[path] = {
        exists: true,
        size: metadata.size,
        hash: createHash("sha256").update(content).digest("hex")
      };
    } catch {
      result[path] = { exists: false };
    }
  }
  return result;
}

export async function loadCodingRunCheckpoint(input: {
  sessionDir: string;
  runId: string;
}): Promise<CodingRunCheckpointRecord | null> {
  try {
    const raw = await readFile(resolve(input.sessionDir, checkpointFileName(input.runId)), "utf8");
    const record = JSON.parse(raw) as CodingRunCheckpointRecord;
    if (record.runId !== input.runId || !record.cwd || !record.checkpoint?.files) return null;
    return record;
  } catch {
    return null;
  }
}

export async function revertCodingRun(input: {
  sessionDir: string;
  runId: string;
}): Promise<{
  filesChanged: string[];
  conflicts: string[];
  nonRewindableFiles: string[];
  status: "restored" | "conflict" | "committed_boundary";
}> {
  const record = await loadCodingRunCheckpoint(input);
  if (!record) throw new Error("当前 Coding Run 没有可撤销的文件检查点");

  const roots = record.roots?.length ? record.roots : [record.cwd];
  const checkpoint = restrictCheckpointToRoots(roots, record.checkpoint);
  const paths = Object.keys(checkpoint.files);
  if (paths.length === 0) throw new Error("当前 Coding Run 没有工作区内的文件检查点");
  if (hasCommitBoundary(record)) {
    return { filesChanged: [], conflicts: [], nonRewindableFiles: paths, status: "committed_boundary" };
  }
  const conflicts = await findFingerprintConflicts(record, paths);
  await Promise.all(paths.map((path) => assertNoSymlinkPathForRoots(roots, path)));
  const safePaths = paths.filter((path) => !conflicts.includes(path));
  const result = await rewindCheckpoint({ ...checkpoint, files: Object.fromEntries(safePaths.map((path) => [path, checkpoint.files[path]!])) });
  if (!result.canRewind) throw new Error(result.error ?? "无法撤销 Coding Run");
  return {
    filesChanged: result.filesChanged ?? safePaths,
    conflicts,
    nonRewindableFiles: [...conflicts, ...(result.skippedFiles ?? [])],
    status: conflicts.length > 0 || (result.skippedFiles?.length ?? 0) > 0 ? "conflict" : "restored"
  };
}

export async function revertCodingFileFromCheckpoint(input: {
  sessionDir: string;
  runId: string;
  path: string;
}): Promise<{ filesChanged: string[]; nonRewindableFiles: string[]; status: "restored" | "conflict" | "committed_boundary" }> {
  const record = await loadCodingRunCheckpoint(input);
  if (!record) throw new Error("当前 Coding Run 没有可撤销的文件检查点");
  const safePath = resolve(record.cwd, input.path);
  const roots = record.roots?.length ? record.roots : [record.cwd];
  await assertNoSymlinkPathForRoots(roots, safePath);
  const snapshot = Object.values(record.checkpoint.files).find((candidate) => resolve(candidate.path) === safePath);
  if (!snapshot) throw new Error("该文件不属于当前 Coding Run 的检查点");
  if (hasCommitBoundary(record)) {
    return { filesChanged: [], nonRewindableFiles: [snapshot.path], status: "committed_boundary" };
  }
  const conflicts = await findFingerprintConflicts(record, [snapshot.path]);
  if (conflicts.length > 0) {
    return { filesChanged: [], nonRewindableFiles: conflicts, status: "conflict" };
  }
  const result = await rewindCheckpoint({
    ...record.checkpoint,
    files: { [snapshot.path]: snapshot }
  });
  if (!result.canRewind) throw new Error(result.error ?? "无法撤销 Coding 文件");
  return { filesChanged: result.filesChanged ?? [snapshot.path], nonRewindableFiles: result.skippedFiles ?? [], status: result.skippedFiles?.length ? "conflict" : "restored" };
}

async function findFingerprintConflicts(record: CodingRunCheckpointRecord, paths: string[]): Promise<string[]> {
  if (!record.after) return [];
  const current = await captureFingerprints(paths);
  return paths.filter((path) => {
    const expected = record.after?.[path];
    if (!expected) return false;
    const actual = current[path] ?? { exists: false };
    return expected.exists !== actual.exists || expected.size !== actual.size || expected.hash !== actual.hash;
  });
}

async function assertNoSymlinkPathForRoots(roots: string[], path: string): Promise<void> {
  const root = roots.find((candidate) => isPathInside(candidate, path));
  if (!root) throw new Error(`拒绝恢复工作区外的文件: ${path}`);
  await assertNoSymlinkPath(root, path);
}

function hasCommitBoundary(record: CodingRunCheckpointRecord): boolean {
  if (!record.baselineCommit) return false;
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: record.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  const currentCommit = result.status === 0 ? result.stdout.trim() : "";
  return Boolean(currentCommit && currentCommit !== record.baselineCommit);
}
