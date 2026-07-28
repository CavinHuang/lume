import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { rewindCheckpoint, type FileCheckpoint, type FileSnapshot } from "@lume/agent-sdk";
import {
  createContentDiffLines,
  parseUnifiedDiff,
  type CodingDiffLine,
  type CodingFileDiff,
} from "./coding-change-service";

const CHECKPOINT_FILE_PREFIX = "coding-checkpoint-";
const MAX_DIFF_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_CHECKPOINT_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_DIFF_OUTPUT_BYTES = 64 * 1024 * 1024;

interface PersistedCodingFileDiff {
  lines: CodingDiffLine[];
  addedLines: number;
  removedLines: number;
}

interface CheckpointCacheEntry {
  record: CodingRunCheckpointRecord;
  size: number;
}

const checkpointCache = new Map<string, CheckpointCacheEntry>();
const checkpointLoadRequests = new Map<string, Promise<CodingRunCheckpointRecord | null>>();
const checkpointDiffBuildRequests = new Map<string, Promise<Record<string, PersistedCodingFileDiff>>>();
let checkpointCacheBytes = 0;

export interface CodingRunCheckpointRecord {
  runId: string;
  cwd: string;
  roots?: string[];
  baselineCommit?: string;
  after?: Record<string, CodingFileFingerprint>;
  afterSnapshots?: Record<string, FileSnapshot>;
  diffs?: Record<string, PersistedCodingFileDiff>;
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
    const absolute = isAbsolute(changedPath) ? resolve(changedPath) : resolve(input.cwd, changedPath);
    if (!roots.some((root) => isPathInside(root, absolute))) continue;
    if (!checkpoint.files[absolute]) checkpoint.files[absolute] = { path: absolute, existed: false };
  }
  if (Object.keys(checkpoint.files).length === 0) return false;

  const afterSnapshots = await captureAfterSnapshots(Object.keys(checkpoint.files));
  const record: CodingRunCheckpointRecord = {
    runId: input.runId,
    cwd: resolve(input.cwd),
    roots,
    baselineCommit: input.baselineCommit,
    after: await captureFingerprints(Object.keys(checkpoint.files)),
    afterSnapshots,
    checkpoint,
    createdAt: new Date().toISOString(),
  };
  record.diffs = await createPersistedDiffs(record);
  await mkdir(input.sessionDir, { recursive: true });
  const path = resolve(input.sessionDir, checkpointFileName(input.runId));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const serialized = JSON.stringify(record);
  await writeFile(temporary, serialized, "utf8");
  await rename(temporary, path);
  cacheCheckpoint(path, record, Buffer.byteLength(serialized, "utf8"));
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

async function captureAfterSnapshots(paths: string[]): Promise<Record<string, FileSnapshot>> {
  const result: Record<string, FileSnapshot> = {};
  for (const path of paths) result[path] = await capturePreviewSnapshot(path);
  return result;
}

async function capturePreviewSnapshot(path: string): Promise<FileSnapshot> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_DIFF_SNAPSHOT_BYTES) {
      return { path, existed: true, unsupported: true };
    }
    const content = await readFile(path);
    const utf16 = content.length >= 2 && content[0] === 0xff && content[1] === 0xfe;
    const utf8Bom = content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
    const body = content.subarray(utf16 ? 2 : utf8Bom ? 3 : 0);
    if (!utf16 && body.subarray(0, 8192).includes(0)) {
      return { path, existed: true, unsupported: true };
    }
    const decoded = body.toString(utf16 ? "utf16le" : "utf8");
    return {
      path,
      existed: true,
      content: decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      encoding: utf16 ? "utf16le" : "utf8",
      lineEnding: decoded.includes("\r\n") ? "CRLF" : decoded.includes("\r") ? "CR" : "LF",
      bom: utf16 || utf8Bom,
      mtimeMs: metadata.mtimeMs,
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: string }).code
      : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return { path, existed: false };
    return { path, existed: true, unsupported: true };
  }
}

function getSnapshotText(snapshot: FileSnapshot): string {
  if (!snapshot.existed) return "";
  if (snapshot.unsupported) throw new Error("该文件过大或格式不受支持，无法预览 Diff");
  if (snapshot.contentBase64) throw new Error("二进制文件无法预览 Diff");
  return snapshot.content ?? "";
}

function getBeforeSnapshotText(
  record: CodingRunCheckpointRecord,
  snapshot: FileSnapshot,
  absolutePath: string,
): string {
  if (!snapshot.unsupported) return getSnapshotText(snapshot);
  const baselineContent = readBaselineContent(record, absolutePath);
  if (baselineContent !== null) return baselineContent;
  throw new Error("Turn 开始前的文件快照不可预览，且无法从基线提交恢复");
}

function readBaselineContent(record: CodingRunCheckpointRecord, absolutePath: string): string | null {
  if (!record.baselineCommit || !/^[0-9a-f]{7,64}$/i.test(record.baselineCommit)) return null;
  const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: record.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (rootResult.status !== 0) return null;
  const gitRoot = rootResult.stdout.trim();
  if (!gitRoot || !isPathInside(gitRoot, absolutePath)) return null;
  const gitPath = relative(gitRoot, absolutePath).split(sep).join("/");
  const result = spawnSync("git", ["show", `${record.baselineCommit}:${gitPath}`], {
    cwd: gitRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_DIFF_SNAPSHOT_BYTES,
  });
  return result.status === 0 ? result.stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : null;
}

function fingerprintsEqual(left: CodingFileFingerprint, right: CodingFileFingerprint): boolean {
  return left.exists === right.exists && left.size === right.size && left.hash === right.hash;
}

export async function loadCodingRunCheckpoint(input: {
  sessionDir: string;
  runId: string;
}): Promise<CodingRunCheckpointRecord | null> {
  const path = resolve(input.sessionDir, checkpointFileName(input.runId));
  const cached = checkpointCache.get(path);
  if (cached) {
    checkpointCache.delete(path);
    checkpointCache.set(path, cached);
    return cached.record;
  }
  const pending = checkpointLoadRequests.get(path);
  if (pending) return pending;

  const request = (async () => {
    try {
      const raw = await readFile(path, "utf8");
      const record = JSON.parse(raw) as CodingRunCheckpointRecord;
      if (record.runId !== input.runId || !record.cwd || !record.checkpoint?.files) return null;
      cacheCheckpoint(path, record, Buffer.byteLength(raw, "utf8"));
      return record;
    } catch {
      return null;
    }
  })().finally(() => {
    checkpointLoadRequests.delete(path);
  });
  checkpointLoadRequests.set(path, request);
  return request;
}

export async function getCodingFileDiffFromCheckpoint(input: {
  sessionDir: string;
  runId: string;
  path: string;
  rootId?: string;
}): Promise<CodingFileDiff | null> {
  const record = await loadCodingRunCheckpoint(input);
  if (!record) return null;

  const roots = record.roots?.length ? record.roots : [record.cwd];
  const selectedRoot = input.rootId
    ? roots.find((root) => codingRootId(root) === input.rootId)
    : record.cwd;
  if (!selectedRoot) throw new Error(`找不到 Coding 根目录: ${input.rootId}`);
  const absolutePath = resolve(selectedRoot, input.path);
  if (!roots.some((root) => isPathInside(root, absolutePath))) {
    throw new Error("文件路径超出 Coding Run 的授权目录");
  }
  await assertNoSymlinkPathForRoots(roots, absolutePath);

  const before = Object.values(record.checkpoint.files)
    .find((snapshot) => resolve(snapshot.path) === absolutePath);
  if (!before) return null;

  let after = record.afterSnapshots?.[absolutePath];
  if (!after) {
    const expected = record.after?.[absolutePath];
    const current = (await captureFingerprints([absolutePath]))[absolutePath] ?? { exists: false };
    if (!expected || !fingerprintsEqual(expected, current)) {
      throw new Error("该历史 Run 未保存最终文件内容，且文件已在后续发生变化，无法安全重建 Diff");
    }
    after = await capturePreviewSnapshot(absolutePath);
  }

  const oldContent = getBeforeSnapshotText(record, before, absolutePath);
  const newContent = getSnapshotText(after);
  let persistedDiff = record.diffs?.[absolutePath];
  if (!record.diffs && record.afterSnapshots) {
    const checkpointPath = resolve(input.sessionDir, checkpointFileName(input.runId));
    const diffs = await ensurePersistedDiffs(checkpointPath, record).catch(() => undefined);
    persistedDiff = diffs?.[absolutePath];
  }
  const lines = persistedDiff?.lines ?? await createSnapshotDiffLines(oldContent, newContent);
  const displayPath = isPathInside(record.cwd, absolutePath)
    ? relative(record.cwd, absolutePath).split(sep).join("/")
    : input.path;

  return {
    rootId: codingRootId(selectedRoot),
    path: displayPath,
    status: !before.existed && after.existed ? "added" : before.existed && !after.existed ? "deleted" : "modified",
    oldContent,
    newContent,
    lines,
    addedLines: persistedDiff?.addedLines ?? lines.filter((line) => line.type === "added").length,
    removedLines: persistedDiff?.removedLines ?? lines.filter((line) => line.type === "removed").length,
  };
}

export async function getCodingRunRoots(input: {
  sessionDir: string;
  runId?: string;
}): Promise<string[]> {
  if (!input.runId) return [];
  const record = await loadCodingRunCheckpoint({
    sessionDir: input.sessionDir,
    runId: input.runId,
  });
  return record?.roots?.length ? [...record.roots] : record?.cwd ? [record.cwd] : [];
}

function cacheCheckpoint(path: string, record: CodingRunCheckpointRecord, size: number): void {
  if (size > MAX_CHECKPOINT_CACHE_BYTES) return;
  const previous = checkpointCache.get(path);
  if (previous) checkpointCacheBytes -= previous.size;
  checkpointCache.delete(path);
  checkpointCache.set(path, { record, size });
  checkpointCacheBytes += size;
  while (checkpointCacheBytes > MAX_CHECKPOINT_CACHE_BYTES) {
    const oldestPath = checkpointCache.keys().next().value;
    if (typeof oldestPath !== "string") break;
    const oldest = checkpointCache.get(oldestPath);
    checkpointCache.delete(oldestPath);
    checkpointCacheBytes -= oldest?.size ?? 0;
  }
}

async function ensurePersistedDiffs(
  checkpointPath: string,
  record: CodingRunCheckpointRecord,
): Promise<Record<string, PersistedCodingFileDiff>> {
  if (record.diffs) return record.diffs;
  const pending = checkpointDiffBuildRequests.get(checkpointPath);
  if (pending) return pending;

  const request = (async () => {
    const diffs = await createPersistedDiffs(record);
    record.diffs = diffs;
    const serialized = JSON.stringify(record);
    const temporary = `${checkpointPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, checkpointPath);
    cacheCheckpoint(checkpointPath, record, Buffer.byteLength(serialized, "utf8"));
    return diffs;
  })().finally(() => {
    checkpointDiffBuildRequests.delete(checkpointPath);
  });
  checkpointDiffBuildRequests.set(checkpointPath, request);
  return request;
}

async function createPersistedDiffs(record: CodingRunCheckpointRecord): Promise<Record<string, PersistedCodingFileDiff>> {
  const entries = Object.entries(record.afterSnapshots ?? {}).flatMap(([absolutePath, after], index) => {
    const before = Object.values(record.checkpoint.files)
      .find((snapshot) => resolve(snapshot.path) === resolve(absolutePath));
    if (!before) return [];
    try {
      return [{
        id: String(index).padStart(6, "0"),
        absolutePath,
        oldContent: getBeforeSnapshotText(record, before, absolutePath),
        newContent: getSnapshotText(after),
      }];
    } catch {
      return [];
    }
  });
  if (entries.length === 0) return {};

  const directory = await mkdtemp(join(tmpdir(), "lume-coding-diffs-"));
  try {
    const beforeDirectory = join(directory, "before");
    const afterDirectory = join(directory, "after");
    await Promise.all([mkdir(beforeDirectory), mkdir(afterDirectory)]);
    await Promise.all(entries.flatMap((entry) => [
      writeFile(join(beforeDirectory, `${entry.id}.txt`), entry.oldContent, "utf8"),
      writeFile(join(afterDirectory, `${entry.id}.txt`), entry.newContent, "utf8"),
    ]));
    const result = spawnSync("git", [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-color",
      "--unified=3",
      "--",
      beforeDirectory,
      afterDirectory,
    ], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: MAX_BATCH_DIFF_OUTPUT_BYTES,
    });
    const parsed = (result.status === 0 || result.status === 1) && typeof result.stdout === "string"
      ? parseBatchDiffs(result.stdout)
      : new Map<string, CodingDiffLine[]>();
    return Object.fromEntries(entries.map((entry) => {
      const lines = parsed.get(entry.id) ?? createContentDiffLines(entry.oldContent, entry.newContent);
      return [entry.absolutePath, {
        lines,
        addedLines: lines.filter((line) => line.type === "added").length,
        removedLines: lines.filter((line) => line.type === "removed").length,
      }];
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseBatchDiffs(output: string): Map<string, CodingDiffLine[]> {
  const result = new Map<string, CodingDiffLine[]>();
  for (const block of output.split(/(?=^diff --git )/m)) {
    const id = block.match(/[\\/](\d{6})\.txt(?:["\s]|$)/)?.[1];
    if (id) result.set(id, parseUnifiedDiff(block));
  }
  return result;
}

async function createSnapshotDiffLines(oldContent: string, newContent: string) {
  const directory = await mkdtemp(join(tmpdir(), "lume-coding-diff-"));
  try {
    const beforePath = join(directory, "before");
    const afterPath = join(directory, "after");
    await Promise.all([
      writeFile(beforePath, oldContent, "utf8"),
      writeFile(afterPath, newContent, "utf8"),
    ]);
    const result = spawnSync("git", [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-color",
      "--unified=3",
      "--",
      beforePath,
      afterPath,
    ], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: MAX_DIFF_SNAPSHOT_BYTES * 3,
    });
    if ((result.status === 0 || result.status === 1) && typeof result.stdout === "string") {
      return parseUnifiedDiff(result.stdout);
    }
    return createContentDiffLines(oldContent, newContent);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
  rootId?: string;
}): Promise<{ filesChanged: string[]; nonRewindableFiles: string[]; status: "restored" | "conflict" | "committed_boundary" }> {
  const record = await loadCodingRunCheckpoint(input);
  if (!record) throw new Error("当前 Coding Run 没有可撤销的文件检查点");
  const roots = record.roots?.length ? record.roots : [record.cwd];
  const selectedRoot = input.rootId
    ? roots.find((root) => codingRootId(root) === input.rootId)
    : record.cwd;
  if (!selectedRoot) throw new Error(`找不到 Coding 根目录: ${input.rootId}`);
  const safePath = resolve(selectedRoot, input.path);
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

function codingRootId(path: string): string {
  const normalized = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
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
