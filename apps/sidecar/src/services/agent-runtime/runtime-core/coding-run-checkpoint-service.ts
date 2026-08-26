import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { rewindCheckpoint, type FileCheckpoint, type FileSnapshot } from "@lume/agent-sdk";
import type { CodingDiffMediaResult } from "@lume/shared";
import {
  createCodingBinaryDiffPayload,
  createCodingMediaDiffPayload,
  createContentDiffLines,
  createCodingTextDiffPayload,
  parseUnifiedDiff,
  type CodingDiffLine,
  type CodingFileDiffResult,
} from "./coding-change-service";
import { createLogger } from "../../infra/logger";

const log = createLogger("coding-run-checkpoint-service");

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
  baselineCommits?: Record<string, string>;
  repositories?: Record<string, string>;
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
  baselineCommits?: Record<string, string>;
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
    baselineCommits: input.baselineCommits,
    repositories: discoverRepositoryRoots(roots),
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
      return { path, existed: true, contentBase64: content.toString("base64"), mtimeMs: metadata.mtimeMs };
    }
    if (/\.(?:7z|a|avi|avif|bin|bmp|class|dll|dylib|eot|exe|flac|gif|gz|ico|jar|jpe?g|m4a|mkv|mov|mp3|mp4|o|ogg|otf|pdf|png|so|tar|tiff?|ttf|wav|webm|webp|woff2?|xz|zip)$/i.test(path)) {
      return { path, existed: true, contentBase64: content.toString("base64"), mtimeMs: metadata.mtimeMs };
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
  probe?: GitProbeCache,
): string {
  if (!snapshot.unsupported) return getSnapshotText(snapshot);
  const baselineContent = readBaselineContent(record, absolutePath, probe);
  if (baselineContent !== null) return baselineContent;
  throw new Error("Turn 开始前的文件快照不可预览，且无法从基线提交恢复");
}

function readBaselineContent(
  record: CodingRunCheckpointRecord,
  absolutePath: string,
  probe?: GitProbeCache,
): string | null {
  // #616③:root 发现至多 2 次 spawnSync rev-parse——批量 diff 循环内逐文件裸调
  // 会以数百次同步 spawn 冻结事件循环;经 probe 按 path 记忆化(#572 同款)
  let gitRoot = probe?.gitRoots.get(resolve(absolutePath));
  if (gitRoot === undefined) {
    gitRoot = findGitRootForPath(absolutePath);
    probe?.gitRoots.set(resolve(absolutePath), gitRoot);
  }
  if (!gitRoot || !isPathInside(gitRoot, absolutePath)) return null;
  const baselineCommit = record.baselineCommits?.[resolve(gitRoot)]
    ?? (isPathInside(gitRoot, record.cwd) ? record.baselineCommit : undefined);
  if (!baselineCommit || !/^[0-9a-f]{7,64}$/i.test(baselineCommit)) return null;
  const gitPath = relative(gitRoot, absolutePath).split(sep).join("/");
  const result = spawnSync("git", ["show", `${baselineCommit}:${gitPath}`], {
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
}): Promise<CodingFileDiffResult | null> {
  const record = await loadCodingRunCheckpoint(input);
  if (!record) return null;

  const roots = record.roots?.length ? record.roots : [record.cwd];
  const selectedRoot = resolveRepositoryRoot(record, input.rootId);
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

  const displayPath = isPathInside(record.cwd, absolutePath)
    ? relative(record.cwd, absolutePath).split(sep).join("/")
    : input.path;
  const status = !before.existed && after.existed ? "added" : before.existed && !after.existed ? "deleted" : "modified";
  const fingerprint = snapshotPairFingerprint(before, after);
  const mediaKind = checkpointMediaKind(displayPath);
  if (mediaKind) {
    return createCodingMediaDiffPayload({
      rootId: input.rootId ?? codingRootId(selectedRoot),
      path: displayPath,
      status,
      mediaKind,
      patch: "",
      fingerprint,
      addedLines: 0,
      removedLines: 0,
      beforeAvailable: before.existed,
      afterAvailable: after.existed,
    });
  }
  if (before.contentBase64 || after.contentBase64 || checkpointBinaryPath(displayPath)) {
    return createCodingBinaryDiffPayload({
      rootId: input.rootId ?? codingRootId(selectedRoot),
      path: displayPath,
      status,
      patch: "",
      fingerprint,
      addedLines: 0,
      removedLines: 0,
    });
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
  return createCodingTextDiffPayload({
    rootId: input.rootId ?? codingRootId(selectedRoot),
    path: displayPath,
    status,
    oldContent,
    newContent,
    lines,
    addedLines: persistedDiff?.addedLines ?? lines.filter((line) => line.type === "added").length,
    removedLines: persistedDiff?.removedLines ?? lines.filter((line) => line.type === "removed").length,
  });
}

export async function getCodingDiffMediaFromCheckpoint(input: {
  sessionDir: string;
  runId: string;
  path: string;
  rootId?: string;
  side: "before" | "after";
}): Promise<CodingDiffMediaResult | null> {
  const record = await loadCodingRunCheckpoint(input);
  if (!record) return null;
  const roots = record.roots?.length ? record.roots : [record.cwd];
  const selectedRoot = resolveRepositoryRoot(record, input.rootId);
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
      throw new Error("该历史 Run 未保存最终媒体，且文件已在后续发生变化");
    }
    after = await capturePreviewSnapshot(absolutePath);
  }
  const snapshot = input.side === "before" ? before : after;
  const data = snapshotBuffer(record, snapshot, absolutePath, input.side);
  if (!data) throw new Error(input.side === "before" ? "文件没有可用的旧版本" : "文件没有可用的新版本");
  if (data.length > 15 * 1024 * 1024) throw new Error("媒体文件过大，无法预览");
  return {
    mediaType: checkpointMediaType(input.path),
    size: data.length,
    dataBase64: data.toString("base64"),
  };
}

function snapshotPairFingerprint(before: FileSnapshot, after: FileSnapshot): string {
  const hash = createHash("sha256");
  for (const snapshot of [before, after]) {
    hash.update(snapshot.existed ? "1" : "0");
    hash.update("\0");
    hash.update(snapshot.contentBase64 ?? snapshot.content ?? (snapshot.unsupported ? "unsupported" : ""));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function checkpointMediaKind(path: string): "image" | "pdf" | undefined {
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.(?:avif|bmp|gif|ico|jpe?g|png|tiff?|webp)$/i.test(path)) return "image";
  return undefined;
}

function checkpointBinaryPath(path: string): boolean {
  return /\.(?:7z|a|avi|bin|class|dll|dylib|eot|exe|flac|gz|jar|m4a|mkv|mov|mp3|mp4|o|ogg|otf|so|tar|ttf|wav|webm|woff2?|xz|zip)$/i.test(path);
}

function checkpointMediaType(path: string): string {
  const extension = path.toLowerCase().match(/\.([^.\\/]+)$/)?.[1];
  const types: Record<string, string> = {
    avif: "image/avif", bmp: "image/bmp", gif: "image/gif", ico: "image/x-icon",
    jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", tif: "image/tiff",
    tiff: "image/tiff", webp: "image/webp", pdf: "application/pdf",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}

function snapshotBuffer(
  record: CodingRunCheckpointRecord,
  snapshot: FileSnapshot,
  absolutePath: string,
  side: "before" | "after",
): Buffer | null {
  if (!snapshot.existed) return null;
  if (snapshot.contentBase64) return Buffer.from(snapshot.contentBase64, "base64");
  if (snapshot.content !== undefined) {
    const body = Buffer.from(snapshot.content, snapshot.encoding === "utf16le" ? "utf16le" : "utf8");
    if (!snapshot.bom) return body;
    return Buffer.concat([
      snapshot.encoding === "utf16le" ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xef, 0xbb, 0xbf]),
      body,
    ]);
  }
  if (side === "before") return readBaselineBuffer(record, absolutePath);
  const expected = record.after?.[absolutePath];
  try {
    const current = {
      exists: true,
      size: statSync(absolutePath).size,
      hash: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
    };
    return expected && fingerprintsEqual(expected, current) ? readFileSync(absolutePath) : null;
  } catch {
    return null;
  }
}

function readBaselineBuffer(record: CodingRunCheckpointRecord, absolutePath: string): Buffer | null {
  const gitRoot = findGitRootForPath(absolutePath);
  if (!gitRoot || !isPathInside(gitRoot, absolutePath)) return null;
  const baselineCommit = record.baselineCommits?.[resolve(gitRoot)]
    ?? (isPathInside(gitRoot, record.cwd) ? record.baselineCommit : undefined);
  if (!baselineCommit || !/^[0-9a-f]{7,64}$/i.test(baselineCommit)) return null;
  const gitPath = relative(gitRoot, absolutePath).split(sep).join("/");
  const result = spawnSync("git", ["show", `${baselineCommit}:${gitPath}`], {
    cwd: gitRoot,
    windowsHide: true,
    maxBuffer: 15 * 1024 * 1024,
  });
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : null;
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

export async function getCodingRunCheckpointPaths(input: {
  sessionDir: string;
  runId: string;
}): Promise<string[]> {
  const record = await loadCodingRunCheckpoint(input);
  if (!record) return [];
  const roots = record.roots?.length ? record.roots : [record.cwd];
  return Object.keys(restrictCheckpointToRoots(roots, record.checkpoint).files);
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
  const probe = createGitProbeCache();
  const entries = Object.entries(record.afterSnapshots ?? {}).flatMap(([absolutePath, after], index) => {
    const before = Object.values(record.checkpoint.files)
      .find((snapshot) => resolve(snapshot.path) === resolve(absolutePath));
    if (!before) return [];
    try {
      return [{
        id: String(index).padStart(6, "0"),
        absolutePath,
        oldContent: getBeforeSnapshotText(record, before, absolutePath, probe),
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
  paths?: string[];
  onFileRestored?: (path: string) => Promise<void> | void;
}): Promise<{
  filesChanged: string[];
  conflicts: string[];
  /** 已提交边界文件（与 conflicts/skipped/failed 不相交；nonRewindableFiles 为四者并集） */
  committedPaths: string[];
  nonRewindableFiles: string[];
  /** 还原时抛错的文件（#714）：逐文件容错折桶，不因单个 IO 失败整批 reject */
  failedFiles: string[];
  status: "restored" | "conflict" | "committed_boundary";
}> {
  const record = await loadCodingRunCheckpoint(input);
  if (!record) throw new Error("当前 Coding Run 没有可撤销的文件检查点");

  const roots = record.roots?.length ? record.roots : [record.cwd];
  const checkpoint = restrictCheckpointToRoots(roots, record.checkpoint);
  const requestedPaths = input.paths?.length
    ? new Set(input.paths.map((path) => isAbsolute(path) ? resolve(path) : resolve(record.cwd, path)))
    : undefined;
  const paths = Object.keys(checkpoint.files)
    .filter((path) => !requestedPaths || requestedPaths.has(resolve(path)));
  if (paths.length === 0) throw new Error("当前 Coding Run 没有工作区内的文件检查点");
  const gitProbe = createGitProbeCache();
  const committedPaths = paths.filter((path) => hasCommitBoundaryForPath(record, path, gitProbe));
  const rewindablePaths = paths.filter((path) => !committedPaths.includes(path));
  const alreadyRestored = await findAlreadyRestoredFiles(record, rewindablePaths);
  const conflicts = (await findFingerprintConflicts(record, rewindablePaths))
    .filter((path) => !alreadyRestored.includes(path));
  await Promise.all(paths.map((path) => assertNoSymlinkPathForRoots(roots, path)));
  const safePaths = rewindablePaths.filter((path) => !conflicts.includes(path) && !alreadyRestored.includes(path));
  const filesChanged = [...alreadyRestored];
  const skippedFiles: string[] = [];
  const failedFiles: string[] = [];
  for (const path of safePaths) {
    const snapshot = checkpoint.files[path]!;
    let result: Awaited<ReturnType<typeof rewindCheckpoint>>;
    try {
      result = await rewindCheckpoint({ ...checkpoint, files: { [path]: snapshot } });
    } catch (error) {
      // 失败桶语义（#714）：单文件 IO 失败折桶随结果返回，其余文件继续还原，
      // 不再整批 reject 丢掉已成功的还原。onFileRestored 回调错误不折桶：
      // journal 中断须暴露且可重入恢复（见 resumable-rewind 测试钉）。
      failedFiles.push(path);
      log.warn("revert 还原单个文件失败", { path, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!result.canRewind) {
      failedFiles.push(path);
      log.warn("revert 还原单个文件失败", { path, error: result.error ?? "无法撤销 Coding 文件" });
      continue;
    }
    if (result.skippedFiles?.includes(path)) {
      skippedFiles.push(path);
      continue;
    }
    filesChanged.push(path);
    await input.onFileRestored?.(path);
  }
  return {
    filesChanged,
    conflicts,
    // 三桶不相交拆分（#572 review）：UI 摘要按类计数，合并并集会把同一文件
    // 既算「外部修改跳过」又算「已提交不可回退」。nonRewindableFiles 保留并集
    // 兼容既有消费方。
    committedPaths,
    failedFiles,
    nonRewindableFiles: [...committedPaths, ...conflicts, ...skippedFiles, ...failedFiles],
    status: committedPaths.length > 0
      ? "committed_boundary"
      : conflicts.length > 0 || skippedFiles.length > 0 || failedFiles.length > 0 ? "conflict" : "restored"
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
  const selectedRoot = resolveRepositoryRoot(record, input.rootId);
  if (!selectedRoot) throw new Error(`找不到 Coding 根目录: ${input.rootId}`);
  const safePath = resolve(selectedRoot, input.path);
  await assertNoSymlinkPathForRoots(roots, safePath);
  const snapshot = Object.values(record.checkpoint.files).find((candidate) => resolve(candidate.path) === safePath);
  if (!snapshot) throw new Error("该文件不属于当前 Coding Run 的检查点");
  if (hasCommitBoundaryForPath(record, snapshot.path)) {
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

async function findAlreadyRestoredFiles(record: CodingRunCheckpointRecord, paths: string[]): Promise<string[]> {
  const current = await captureFingerprints(paths);
  return paths.filter((path) => {
    const snapshot = record.checkpoint.files[path];
    if (!snapshot || snapshot.unsupported) return false;
    const expected = fingerprintSnapshot(snapshot);
    const actual = current[path] ?? { exists: false };
    return fingerprintsEqual(expected, actual);
  });
}

function fingerprintSnapshot(snapshot: FileSnapshot): CodingFileFingerprint {
  if (!snapshot.existed) return { exists: false };
  const content = encodeSnapshot(snapshot);
  return {
    exists: true,
    size: content.length,
    hash: createHash("sha256").update(content).digest("hex"),
  };
}

function encodeSnapshot(snapshot: FileSnapshot): Buffer {
  if (snapshot.contentBase64) return Buffer.from(snapshot.contentBase64, "base64");
  const lineEnding = snapshot.lineEnding ?? "LF";
  const normalized = (snapshot.content ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const restored = lineEnding === "CRLF"
    ? normalized.replace(/\n/g, "\r\n")
    : lineEnding === "CR" ? normalized.replace(/\n/g, "\r") : normalized;
  const encoding = snapshot.encoding ?? "utf8";
  const body = Buffer.from(restored, encoding);
  if (!snapshot.bom) return body;
  return encoding === "utf16le"
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), body])
    : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]);
}

async function assertNoSymlinkPathForRoots(roots: string[], path: string): Promise<void> {
  const root = roots.find((candidate) => isPathInside(candidate, path));
  if (!root) throw new Error(`拒绝恢复工作区外的文件: ${path}`);
  await assertNoSymlinkPath(root, path);
}

/**
 * 单次 revert 的 git 探测缓存（#572 review P1）：hasCommitBoundaryForPath 对
 * 每路径原本各跑 findGitRootForPath（2 次 spawnSync）+ rev-parse HEAD（1 次），
 * 数百文件的 checkpoint 会以同步 spawn 冻结事件循环数秒。gitRoot 按 path→root
 * 记忆化、HEAD 按根去重后整次 revert 每仓库只探一次。
 */
interface GitProbeCache {
  gitRoots: Map<string, string | null>;
  headByRoot: Map<string, string>;
}

function createGitProbeCache(): GitProbeCache {
  return { gitRoots: new Map(), headByRoot: new Map() };
}

function hasCommitBoundaryForPath(record: CodingRunCheckpointRecord, path: string, probe?: GitProbeCache): boolean {
  const cacheKey = resolve(path);
  let gitRoot = probe?.gitRoots.get(cacheKey);
  if (gitRoot === undefined) {
    gitRoot = findGitRootForPath(path);
    probe?.gitRoots.set(cacheKey, gitRoot);
  }
  if (!gitRoot) return false;
  const rootKey = resolve(gitRoot);
  const baselineCommit = record.baselineCommits?.[rootKey]
    ?? (isPathInside(gitRoot, record.cwd) ? record.baselineCommit : undefined);
  if (!baselineCommit) return false;
  let currentCommit = probe?.headByRoot.get(rootKey);
  if (currentCommit === undefined) {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: gitRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    currentCommit = result.status === 0 ? result.stdout.trim() : "";
    probe?.headByRoot.set(rootKey, currentCommit);
  }
  return Boolean(currentCommit && currentCommit !== baselineCommit);
}

function discoverRepositoryRoots(roots: string[]): Record<string, string> {
  const repositories: Record<string, string> = {};
  for (const root of roots) {
    const gitRoot = findGitRootForPath(root) ?? resolve(root);
    repositories[codingRootId(gitRoot)] = gitRoot;
  }
  return repositories;
}

function resolveRepositoryRoot(record: CodingRunCheckpointRecord, rootId?: string): string | undefined {
  if (!rootId) return record.cwd;
  const persisted = record.repositories?.[rootId];
  if (persisted) return persisted;
  const roots = record.roots?.length ? record.roots : [record.cwd];
  return roots.find((root) => codingRootId(findGitRootForPath(root) ?? root) === rootId);
}

function findGitRootForPath(path: string): string | null {
  let cwd = resolve(path);
  try {
    const metadata = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 1000,
    });
    if (metadata.status === 0 && metadata.stdout.trim()) return resolve(metadata.stdout.trim());
  } catch {
    // A file path is not a valid cwd; retry from its parent.
  }
  cwd = dirname(cwd);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 1000,
  });
  return result.status === 0 && result.stdout.trim() ? resolve(result.stdout.trim()) : null;
}
