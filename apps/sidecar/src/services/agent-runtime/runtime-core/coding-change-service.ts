import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { createLogger } from "../../infra/logger";
import type {
  AgentWorkspaceGitInfo,
  CodingBinaryDiffPayload,
  CodingBlameResult,
  CodingDiffActionInput,
  CodingDiffActionResult,
  CodingDiffActions,
  CodingDiffMediaResult,
  CodingFileOpenTargets,
  CodingMediaDiffPayload,
  CodingRepositoryPublishActionInput,
  CodingRepositoryPublishActionResult,
  CodingRepositoryPublishState,
  CodingReviewSearchFile,
  CodingReviewSearchMatch,
  CodingReviewSearchResult,
  CodingReviewSource,
  CodingReviewSourcesResult,
  RuntimeCodingChangeSet,
  RuntimeCodingFileChange,
  RuntimeCodingRepository,
} from "@lume/shared";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const GIT_PUBLISH_TIMEOUT_MS = 120_000;
const MAX_REVIEW_SEARCH_OUTPUT_BYTES = 16 * 1024 * 1024;
// 字符串版 runGitCommand 同款水位：超限 kill 返回 null，防 binary diff 场景内存暴涨（#594）
const MAX_GIT_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const log = createLogger("coding-change-git");
const MAX_BLAME_CACHE_ENTRIES = 128;
const blameCache = new Map<string, CodingBlameResult>();
const SHOULD_ISOLATE_GIT_SPAWN = "bun" in process.versions;
const GIT_COMMAND_WORKER_SOURCE = String.raw`
  const { spawn } = require("node:child_process");
  const { parentPort } = require("node:worker_threads");

  parentPort.on("message", ({ id, args, cwd, timeoutMs }) => {
    let settled = false;
    // diag：异常终态原因回传主线程记日志（worker 内无 logger），正常完成不带
    const finish = (value, diag) => {
      if (settled) return;
      settled = true;
      parentPort.postMessage(diag ? { id, value, diag } : { id, value });
    };
    let child;
    try {
      child = spawn("git", ["-c", "core.quotePath=false", ...args], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (error) {
      finish(null, { reason: "spawn_error", message: String(error && error.message || error) });
      return;
    }
    child.stdout.setEncoding("utf8");
    let stdout = "";
    let stdoutBytes = 0;
    let outputDiscarded = false;
    child.stdout.on("data", (chunk) => {
      if (outputDiscarded) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes <= ${MAX_GIT_COMMAND_OUTPUT_BYTES}) stdout += chunk;
      else {
        outputDiscarded = true;
        child.kill("SIGKILL");
      }
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(null, { reason: "timeout", message: "git command timed out" });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      finish(null, { reason: "error_event", message: String(error && error.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      finish(code === 0 && stdoutBytes <= ${MAX_GIT_COMMAND_OUTPUT_BYTES} ? stdout : null);

    });
  });
`;
let gitCommandWorker: Worker | undefined;
let nextGitCommandId = 1;
const pendingGitCommands = new Map<number, { resolve: (value: string | null) => void; args: string[]; cwd: string }>();

export interface CodingFileDiff {
  kind: "text";
  rootId?: string;
  path: string;
  status: RuntimeCodingFileChange["status"];
  oldContent: string;
  newContent: string;
  patch: string;
  diffHash: string;
  actions: CodingDiffActions;
  lines: CodingDiffLine[];
  addedLines: number;
  removedLines: number;
}

export type CodingFileDiffResult = CodingFileDiff | CodingMediaDiffPayload | CodingBinaryDiffPayload;

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
  options: {
    paths?: Iterable<string>;
    turnId?: string;
    roots?: Iterable<string>;
    reviewSource?: CodingReviewSource;
  } = {}
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
  options: {
    paths?: Iterable<string>;
    turnId?: string;
    reviewSource?: CodingReviewSource;
  } = {}
): Promise<RuntimeCodingChangeSet> {
  const root = resolve(workspaceRoot);
  const gitRoot = await findGitRoot(root);
  if (!gitRoot) {
    const files = options.reviewSource?.kind === "staged"
      || options.reviewSource?.kind === "branch"
      || options.reviewSource?.kind === "commit"
      ? []
      : await getSnapshotFileChanges(root, options.paths);
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
  const reviewSpec = await resolveGitReviewSpec(gitRoot, options.reviewSource);
  const tracked = parseNumstat(await runGitCommand([...reviewSpec.diffPrefix, "--numstat", "--find-renames", "-z"], gitRoot));
  const statuses = parseStatuses(await runGitCommand([...reviewSpec.diffPrefix, "--name-status", "--find-renames", "-z"], gitRoot));
  const untracked = reviewSpec.includeUntracked
    ? parseNulPaths(await runGitCommand(["ls-files", "--others", "--exclude-standard", "-z"], gitRoot))
    : [];
  const byPath = new Map<string, GitFileEntry>();

  for (const entry of statuses) {
    if (allowedPaths && !matchesPathFilter(allowedPaths, entry.path)) continue;
    const stats = tracked.get(entry.path) ?? { addedLines: 0, removedLines: 0 };
    byPath.set(entry.path, {
      path: entry.path,
      status: entry.status,
      ...stats,
    });
  }
  for (const path of untracked) {
    if (allowedPaths && !matchesPathFilter(allowedPaths, path)) continue;
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

export async function getCodingReviewSources(
  workspaceRoot: string,
  options: { rootId?: string; roots?: Iterable<string> } = {},
): Promise<CodingReviewSourcesResult> {
  const selectedRoot = await resolveCodingRepositoryRoot(workspaceRoot, options);
  if (!selectedRoot) {
    return { available: false, branches: [], commits: [], reason: "找不到目标工作区" };
  }
  const gitRoot = await findGitRoot(selectedRoot.path);
  if (!gitRoot) {
    return {
      available: false,
      rootId: selectedRoot.repository.rootId,
      branches: [],
      commits: [],
      reason: "当前工作区不是 Git 仓库",
    };
  }
  const branchInfo = await getGitBranchInfo(gitRoot);
  const branchOutput = await runGitCommand([
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ], gitRoot);
  const branches = [...new Set(normalizeLineEndings(branchOutput ?? "")
    .split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch
      && branch !== branchInfo?.name
      && !branch.endsWith("/HEAD")))]
    .sort((left, right) => left.localeCompare(right));
  const defaultCandidates = [
    branchInfo?.upstream,
    "origin/main",
    "main",
    "origin/master",
    "master",
    branches[0],
  ];
  const defaultBaseRef = defaultCandidates.find((candidate) => candidate && branches.includes(candidate));
  const logOutput = await runGitCommand([
    "log",
    "-n",
    "50",
    "--format=%H%x1f%s%x1f%aI%x1e",
  ], gitRoot);
  const commits = (logOutput ?? "")
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const [sha, subject, authoredAt] = record.split("\x1f");
      return sha && subject !== undefined && authoredAt && /^[a-f0-9]{40}$/i.test(sha)
        ? [{ sha, subject, authoredAt }]
        : [];
    });
  return {
    available: true,
    rootId: selectedRoot.repository.rootId,
    ...(branchInfo?.name ? { currentBranch: branchInfo.name } : {}),
    ...(defaultBaseRef ? { defaultBaseRef } : {}),
    branches,
    commits,
  };
}

export interface SearchableCodingDiff extends CodingReviewSearchFile {
  lines: CodingDiffLine[]
}

export function searchCodingDiffLines(
  files: SearchableCodingDiff[],
  query: string,
  limit = 100,
): CodingReviewSearchResult {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { matches: [], truncated: false };
  const matches: CodingReviewSearchMatch[] = [];
  let truncated = false;
  const addMatch = (match: CodingReviewSearchMatch) => {
    if (matches.length < limit) matches.push(match);
    else truncated = true;
  };

  for (const file of files) {
    const pathIndex = file.path.toLocaleLowerCase().indexOf(needle);
    if (pathIndex >= 0) {
      const preview = createSearchPreview(file.path, pathIndex, query.trim().length);
      addMatch({
        path: file.path,
        ...(file.rootId ? { rootId: file.rootId } : {}),
        kind: "path",
        ...preview,
      });
    }
    for (const line of file.lines) {
      const matchIndex = line.text.toLocaleLowerCase().indexOf(needle);
      if (matchIndex < 0) continue;
      const preview = createSearchPreview(line.text, matchIndex, query.trim().length);
      addMatch({
        path: file.path,
        ...(file.rootId ? { rootId: file.rootId } : {}),
        kind: "line",
        side: line.type === "added" ? "additions" : line.type === "removed" ? "deletions" : "context",
        lineNumber: line.type === "removed" ? line.oldLine : line.newLine,
        ...preview,
      });
    }
  }
  return { matches, truncated };
}

export async function searchCodingReview(
  workspaceRoot: string,
  input: {
    query: string;
    limit?: number;
    files: CodingReviewSearchFile[];
    reviewSource?: CodingReviewSource;
    roots?: Iterable<string>;
  },
): Promise<CodingReviewSearchResult> {
  const roots = await discoverCodingRoots([workspaceRoot, ...(input.roots ?? [])]);
  const searchableFiles: SearchableCodingDiff[] = [];
  let outputTruncated = false;

  for (const [rootIndex, root] of roots.entries()) {
    const requestedFiles = input.files.filter((file) => file.rootId
      ? file.rootId === root.repository.rootId
      : roots.length === 1 || rootIndex === 0);
    const safeFiles = [...new Map(requestedFiles.flatMap((file) => {
      const path = normalizeSafePath(root.path, file.path);
      return path ? [[path, { path, rootId: root.repository.rootId }] as const] : [];
    })).values()];
    if (safeFiles.length === 0) continue;

    const gitRoot = await findGitRoot(root.path);
    if (!gitRoot) {
      for (const file of safeFiles) {
        let lines: CodingDiffLine[] = [];
        try {
          if (await isPreviewableFile(root.path, file.path)) {
            lines = createAddedLines(readSafeContent(root.path, file.path), "added");
          }
        } catch {
          // Path matches remain searchable when content cannot be previewed.
        }
        searchableFiles.push({ ...file, lines });
      }
      continue;
    }

    const reviewSpec = await resolveGitReviewSpec(gitRoot, input.reviewSource);
    const diffResult = await runGitSearchDiff([
      ...reviewSpec.diffPrefix,
      "--no-ext-diff",
      "--no-color",
      "--no-textconv",
      "--find-renames",
      "--unified=3",
    ], gitRoot);
    outputTruncated ||= diffResult.truncated;
    const linesByPath = parseReviewSearchDiff(diffResult.output);
    const untracked = reviewSpec.includeUntracked
      ? new Set(parseNulPaths(await runGitCommand(["ls-files", "--others", "--exclude-standard", "-z"], gitRoot)))
      : new Set<string>();

    for (const file of safeFiles) {
      let lines = linesByPath.get(file.path) ?? [];
      if (lines.length === 0 && untracked.has(file.path)) {
        try {
          if (await isPreviewableFile(gitRoot, file.path)) {
            lines = createAddedLines(readSafeContent(gitRoot, file.path), "untracked");
          }
        } catch {
          // Keep the path result even when an untracked file is too large or binary.
        }
      }
      searchableFiles.push({ ...file, lines });
    }
  }

  const result = searchCodingDiffLines(searchableFiles, input.query, input.limit);
  return { ...result, truncated: result.truncated || outputTruncated };
}

function createSearchPreview(text: string, matchIndex: number, matchLength: number) {
  const maxLength = 240;
  let start = Math.max(0, matchIndex - 80);
  let end = Math.min(text.length, start + maxLength);
  if (end === text.length) start = Math.max(0, end - maxLength);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return {
    preview: `${prefix}${text.slice(start, end)}${suffix}`,
    matchStart: prefix.length + matchIndex - start,
    matchLength,
  };
}

function parseReviewSearchDiff(output: string): Map<string, CodingDiffLine[]> {
  const result = new Map<string, CodingDiffLine[]>();
  for (const block of normalizeLineEndings(output).split(/(?=^diff --git )/m)) {
    if (!block.startsWith("diff --git ")) continue;
    const newPath = block.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    const oldPath = block.match(/^--- a\/(.+)$/m)?.[1];
    const path = newPath && newPath !== "/dev/null" ? newPath : oldPath;
    if (path) result.set(path, parseUnifiedDiff(block));
  }
  return result;
}

type GitReviewContentSource =
  | { kind: "ref"; ref: string }
  | { kind: "index" }
  | { kind: "worktree" };

interface GitReviewSpec {
  diffPrefix: string[]
  before: GitReviewContentSource
  after: GitReviewContentSource
  includeUntracked: boolean
  readOnly: boolean
}

const EMPTY_GIT_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function resolveGitReviewSpec(
  gitRoot: string,
  source: CodingReviewSource = { kind: "uncommitted" },
): Promise<GitReviewSpec> {
  if (source.kind === "branch") {
    if (source.baseRef.startsWith("-")) throw new Error("无效的比较分支");
    const baseCommit = (await runGitCommand(["rev-parse", "--verify", `${source.baseRef}^{commit}`], gitRoot))?.trim();
    if (!baseCommit || !/^[a-f0-9]{40}$/i.test(baseCommit)) throw new Error("比较分支已不存在，请刷新 Review 来源");
    const mergeBase = (await runGitCommand(["merge-base", "HEAD", baseCommit], gitRoot))?.trim();
    if (!mergeBase || !/^[a-f0-9]{40}$/i.test(mergeBase)) throw new Error("无法确定分支比较基线");
    return {
      diffPrefix: ["diff", mergeBase],
      before: { kind: "ref", ref: mergeBase },
      after: { kind: "worktree" },
      includeUntracked: true,
      readOnly: true,
    };
  }
  if (source.kind === "commit") {
    const commit = (await runGitCommand(["rev-parse", "--verify", `${source.commitSha}^{commit}`], gitRoot))?.trim();
    if (!commit || commit.toLowerCase() !== source.commitSha.toLowerCase()) {
      throw new Error("目标提交已不存在，请刷新 Review 来源");
    }
    const parents = (await runGitCommand(["rev-list", "--parents", "-n", "1", commit], gitRoot))?.trim().split(/\s+/) ?? [];
    const parent = parents[1] ?? EMPTY_GIT_TREE;
    return {
      diffPrefix: ["diff", parent, commit],
      before: { kind: "ref", ref: parent },
      after: { kind: "ref", ref: commit },
      includeUntracked: false,
      readOnly: true,
    };
  }
  if (source.kind === "staged") {
    return {
      diffPrefix: ["diff", "--cached"],
      before: { kind: "ref", ref: "HEAD" },
      after: { kind: "index" },
      includeUntracked: false,
      readOnly: false,
    };
  }
  if (source.kind === "unstaged") {
    return {
      diffPrefix: ["diff"],
      before: { kind: "index" },
      after: { kind: "worktree" },
      includeUntracked: true,
      readOnly: false,
    };
  }
  return {
    diffPrefix: ["diff", "HEAD"],
    before: { kind: "ref", ref: "HEAD" },
    after: { kind: "worktree" },
    includeUntracked: true,
    readOnly: false,
  };
}

export async function getCodingFileDiff(
  workspaceRoot: string,
  filePath: string,
  options: {
    rootId?: string;
    roots?: Iterable<string>;
    reviewSource?: CodingReviewSource;
  } = {}
): Promise<CodingFileDiffResult> {
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
    const richMediaKind = getRichMediaKind(safePath);
    if (richMediaKind === "image" || richMediaKind === "pdf") {
      return createCodingMediaDiffPayload({
        rootId: selectedRoot.repository.rootId,
        path: safePath,
        status: "modified",
        mediaKind: richMediaKind,
        patch: "",
        addedLines: 0,
        removedLines: 0,
        beforeAvailable: false,
        afterAvailable: true,
        actions: snapshotActions(),
        fingerprint: fileFingerprint(root, safePath),
      });
    }
    if (isKnownBinaryPath(safePath)) {
      return createCodingBinaryDiffPayload({
        rootId: selectedRoot.repository.rootId,
        path: safePath,
        status: "modified",
        patch: "",
        addedLines: 0,
        removedLines: 0,
        actions: snapshotActions(),
        fingerprint: fileFingerprint(root, safePath),
      });
    }
    const newContent = readSafeContent(root, safePath);
    if (newContent.includes("\0")) {
      return createCodingBinaryDiffPayload({
        rootId: selectedRoot.repository.rootId,
        path: safePath,
        status: "modified",
        patch: "",
        addedLines: 0,
        removedLines: 0,
        actions: snapshotActions(),
        fingerprint: fileFingerprint(root, safePath),
      });
    }
    const lines = createAddedLines(newContent, "added");
    return createCodingTextDiffPayload({
      rootId: selectedRoot.repository.rootId,
      path: safePath,
      status: "modified",
      oldContent: "",
      newContent,
      lines,
      addedLines: countLines(newContent),
      removedLines: 0,
      actions: snapshotActions(),
    });
  }
  const safePath = normalizeSafePath(gitRoot, filePath);
  if (!safePath) throw new Error("文件路径超出项目目录");

  const reviewSpec = await resolveGitReviewSpec(gitRoot, options.reviewSource);
  const changeSet = await getSingleCodingChangeSet(gitRoot, {
    paths: [safePath],
    reviewSource: options.reviewSource,
  });
  const file = changeSet.files[0];
  if (!file) throw new Error("文件当前没有可审核的变更");
  const gitDiff = await runGitCommand([
    ...reviewSpec.diffPrefix,
    "--no-ext-diff",
    "--no-color",
    "--unified=3",
    "--",
    safePath,
  ], gitRoot);
  const actions = reviewSpec.readOnly
    ? readOnlyGitActions("此 Review 来源是只读比较")
    : await getGitDiffActions(gitRoot, safePath, file.status);
  const richMediaKind = getRichMediaKind(safePath);
  if (richMediaKind === "image" || richMediaKind === "pdf") {
    return createCodingMediaDiffPayload({
      rootId: selectedRoot.repository.rootId,
      path: safePath,
      status: file.status,
      mediaKind: richMediaKind,
      patch: gitDiff ?? "",
      addedLines: file.addedLines ?? 0,
      removedLines: file.removedLines ?? 0,
      beforeAvailable: file.status !== "added" && file.status !== "untracked",
      afterAvailable: file.status !== "deleted",
      actions,
      fingerprint: await getGitFileFingerprint(gitRoot, safePath),
    });
  }
  if (isKnownBinaryPath(safePath)) {
    return createCodingBinaryDiffPayload({
      rootId: selectedRoot.repository.rootId,
      path: safePath,
      status: file.status,
      patch: gitDiff ?? "",
      addedLines: file.addedLines ?? 0,
      removedLines: file.removedLines ?? 0,
      actions,
      fingerprint: await getGitFileFingerprint(gitRoot, safePath),
    });
  }
  const oldContent = file.status === "untracked" || file.status === "added"
    ? ""
    : await readGitTextSource(gitRoot, safePath, reviewSpec.before);
  const newContent = file.status === "deleted"
    ? ""
    : await readGitTextSource(gitRoot, safePath, reviewSpec.after);
  if (oldContent.includes("\0") || newContent.includes("\0")) {
    return createCodingBinaryDiffPayload({
      rootId: selectedRoot.repository.rootId,
      path: safePath,
      status: file.status,
      patch: gitDiff ?? "",
      addedLines: file.addedLines ?? 0,
      removedLines: file.removedLines ?? 0,
      actions,
      fingerprint: await getGitFileFingerprint(gitRoot, safePath),
    });
  }
  const lines = gitDiff ? parseUnifiedDiff(gitDiff) : createAddedLines(newContent, file.status);
  return createCodingTextDiffPayload({
    rootId: selectedRoot.repository.rootId,
    path: safePath,
    status: file.status,
    oldContent,
    newContent,
    patch: gitDiff ?? createUnifiedPatch(safePath, oldContent, newContent),
    lines,
    addedLines: file.addedLines ?? 0,
    removedLines: file.removedLines ?? 0,
    actions,
  });
}

export function createCodingTextDiffPayload(input: Omit<CodingFileDiff, "kind" | "patch" | "diffHash" | "actions"> & {
  patch?: string;
  actions?: CodingDiffActions;
}): CodingFileDiff {
  const patch = input.patch ?? createUnifiedPatch(input.path, input.oldContent, input.newContent);
  const actions = input.actions ?? snapshotActions();
  return {
    kind: "text",
    ...input,
    patch,
    actions,
    diffHash: hashDiff(input.path, input.status, patch, input.oldContent, input.newContent, actions),
  };
}

export async function applyCodingDiffAction(
  workspaceRoot: string,
  input: CodingDiffActionInput,
  options: { roots?: Iterable<string> } = {},
): Promise<CodingDiffActionResult> {
  const discoveredRoots = await discoverCodingRoots([workspaceRoot, ...(options.roots ?? [])]);
  const selectedRoot = input.rootId
    ? discoveredRoots.find((candidate) => candidate.repository.rootId === input.rootId)
    : discoveredRoots[0];
  if (!selectedRoot) throw new Error(`找不到 Coding 根目录: ${input.rootId ?? workspaceRoot}`);
  const gitRoot = await findGitRoot(selectedRoot.path);
  if (!gitRoot) throw new Error("当前目录不是 Git 仓库");
  if (input.scope === "section") {
    return applyCodingDiffSectionAction(
      workspaceRoot,
      gitRoot,
      selectedRoot.repository.rootId,
      input,
      options,
    );
  }
  const safePath = normalizeSafePath(gitRoot, input.path);
  if (!safePath) throw new Error("文件路径超出项目目录");

  const current = await getCodingFileDiff(workspaceRoot, safePath, {
    rootId: selectedRoot.repository.rootId,
    roots: options.roots,
    reviewSource: { kind: input.stageFilter ?? "uncommitted" },
  });
  if (current.diffHash !== input.expectedDiffHash) {
    throw new Error("文件变更已更新，请刷新 Diff 后重试");
  }

  const actions = current.actions;
  let patch = "";
  let args: string[] = [];
  if (input.action === "stage") {
    if (!actions.canStage) throw new Error("当前文件没有可 Stage 的变更");
    const unstagedPatch = await runGitCommand(["diff", "--no-ext-diff", "--no-color", "--binary", "--unified=3", "--", safePath], gitRoot);
    if (unstagedPatch === null) throw new Error(`文件变更超过 ${MAX_GIT_COMMAND_OUTPUT_BYTES / 1024 / 1024}MB 补丁上限，无法生成补丁`);
    patch = unstagedPatch;
    if (!patch && current.status === "untracked" && input.scope === "file") {
      await runGitAction(["add", "--", safePath], gitRoot);
      return { ok: true };
    }
    args = ["apply", "--cached"];
  } else {
    if (!actions.canUnstage) throw new Error("当前文件没有可 Unstage 的变更");
    const stagedPatch = await runGitCommand(["diff", "--cached", "--no-ext-diff", "--no-color", "--binary", "--unified=3", "--", safePath], gitRoot);
    if (stagedPatch === null) throw new Error(`文件变更超过 ${MAX_GIT_COMMAND_OUTPUT_BYTES / 1024 / 1024}MB 补丁上限，无法生成补丁`);
    patch = stagedPatch;
    args = ["apply", "--cached", "--reverse"];
  }
  if (!patch) throw new Error("没有可应用的 Diff");
  if (input.scope === "hunk") {
    patch = extractPatchHunk(patch, input.hunkIndex);
  }
  await runGitAction([...args, "--check", "--whitespace=nowarn", "-"], gitRoot, patch);
  await runGitAction([...args, "--whitespace=nowarn", "-"], gitRoot, patch);
  return { ok: true };
}

async function applyCodingDiffSectionAction(
  workspaceRoot: string,
  gitRoot: string,
  rootId: string,
  input: Extract<CodingDiffActionInput, { scope: "section" }>,
  options: { roots?: Iterable<string> },
): Promise<CodingDiffActionResult> {
  const safeFiles = input.files.map((file) => {
    const path = normalizeSafePath(gitRoot, file.path);
    if (!path) throw new Error(`文件路径超出项目目录: ${file.path}`);
    return { ...file, path };
  });
  if (new Set(safeFiles.map((file) => file.path)).size !== safeFiles.length) {
    throw new Error("分区操作不能包含重复文件");
  }

  const currentFiles = await Promise.all(safeFiles.map(async (file) => ({
    requested: file,
    current: await getCodingFileDiff(workspaceRoot, file.path, {
      rootId,
      roots: options.roots,
      reviewSource: { kind: input.stageFilter ?? "uncommitted" },
    }),
  })));
  for (const file of currentFiles) {
    if (file.current.diffHash !== file.requested.expectedDiffHash) {
      throw new Error(`${file.requested.path} 的变更已更新，请刷新 Diff 后重试`);
    }
  }

  if (input.action === "stage") {
    const unavailable = currentFiles.find(({ current }) => !current.actions.canStage);
    if (unavailable) throw new Error(`${unavailable.requested.path} 没有可 Stage 的变更`);
    await runGitAction(["add", "--", ...safeFiles.map((file) => file.path)], gitRoot);
    return { ok: true };
  }

  const unavailable = currentFiles.find(({ current }) => !current.actions.canUnstage);
  if (unavailable) throw new Error(`${unavailable.requested.path} 没有可 Unstage 的变更`);
  const patch = await runGitCommand([
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-color",
    "--binary",
    "--unified=3",
    "--",
    ...safeFiles.map((file) => file.path),
  ], gitRoot);
  if (patch === null) throw new Error(`分区变更超过 ${MAX_GIT_COMMAND_OUTPUT_BYTES / 1024 / 1024}MB 补丁上限，无法生成补丁`);
  if (!patch) throw new Error("没有可 Unstage 的 Diff");
  await runGitAction(["apply", "--cached", "--reverse", "--check", "--whitespace=nowarn", "-"], gitRoot, patch);
  await runGitAction(["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"], gitRoot, patch);
  return { ok: true };
}

export async function getCodingBlame(
  workspaceRoot: string,
  filePath: string,
  options: { rootId?: string; roots?: Iterable<string> } = {},
): Promise<CodingBlameResult> {
  const discoveredRoots = await discoverCodingRoots([workspaceRoot, ...(options.roots ?? [])]);
  const selectedRoot = options.rootId
    ? discoveredRoots.find((candidate) => candidate.repository.rootId === options.rootId)
    : discoveredRoots[0];
  if (!selectedRoot) return { available: false, lines: [] };
  const gitRoot = await findGitRoot(selectedRoot.path);
  if (!gitRoot) return { available: false, lines: [] };
  const safePath = normalizeSafePath(gitRoot, filePath);
  if (!safePath) throw new Error("文件路径超出项目目录");
  const target = resolve(gitRoot, safePath);
  const metadata = existsSync(target) ? statSync(target) : undefined;
  const head = (await runGitCommand(["rev-parse", "HEAD"], gitRoot))?.trim() ?? "";
  const cacheKey = `${gitRoot}\0${safePath}\0${head}\0${metadata?.size ?? -1}\0${metadata?.mtimeMs ?? -1}`;
  const cached = blameCache.get(cacheKey);
  if (cached) {
    blameCache.delete(cacheKey);
    blameCache.set(cacheKey, cached);
    return cached;
  }
  const output = await runGitCommand(["blame", "--line-porcelain", "--", safePath], gitRoot);
  if (!output) return { available: false, lines: [] };
  const remote = await runGitCommand(["remote", "get-url", "origin"], gitRoot);
  const remoteBase = remote ? normalizeRemoteUrl(remote.trim()) : undefined;
  const result: CodingBlameResult = { available: true, lines: parseBlamePorcelain(output, remoteBase) };
  blameCache.set(cacheKey, result);
  while (blameCache.size > MAX_BLAME_CACHE_ENTRIES) {
    const oldest = blameCache.keys().next().value;
    if (typeof oldest !== "string") break;
    blameCache.delete(oldest);
  }
  return result;
}

export async function getCodingFileOpenTargets(
  workspaceRoot: string,
  filePath: string,
  options: { rootId?: string; roots?: Iterable<string> } = {},
): Promise<CodingFileOpenTargets> {
  const discoveredRoots = await discoverCodingRoots([workspaceRoot, ...(options.roots ?? [])]);
  const selectedRoot = options.rootId
    ? discoveredRoots.find((candidate) => candidate.repository.rootId === options.rootId)
    : discoveredRoots[0];
  if (!selectedRoot) throw new Error(`找不到 Coding 根目录: ${options.rootId ?? workspaceRoot}`);
  const safePath = normalizeSafePath(selectedRoot.path, filePath);
  if (!safePath) throw new Error("文件路径超出项目目录");
  const target = resolve(selectedRoot.path, safePath);
  const result: CodingFileOpenTargets = {};
  if (existsSync(target) && statSync(target).isFile()) result.absolutePath = realpathSync.native(target);

  const gitRoot = await findGitRoot(selectedRoot.path);
  if (!gitRoot) return result;
  const revision = (await runGitCommand(["rev-parse", "HEAD"], gitRoot))?.trim();
  const remote = await runGitCommand(["remote", "get-url", "origin"], gitRoot);
  const remoteBase = remote ? normalizeRemoteUrl(remote.trim()) : undefined;
  const provider = remoteProvider(remoteBase);
  if (!revision || !remoteBase || !provider) return result;
  const encodedPath = safePath.split("/").map(encodeURIComponent).join("/");
  result.revision = revision;
  result.remoteProvider = provider;
  result.remoteFileUrl = provider === "gitlab"
    ? `${remoteBase}/-/blob/${revision}/${encodedPath}`
    : `${remoteBase}/blob/${revision}/${encodedPath}`;
  return result;
}

export async function getCodingRepositoryPublishState(
  workspaceRoot: string,
  options: { rootId?: string; roots?: Iterable<string> } = {},
): Promise<CodingRepositoryPublishState> {
  const selectedRoot = await resolveCodingRepositoryRoot(workspaceRoot, options);
  if (!selectedRoot || selectedRoot.repository.kind !== "git") {
    return { available: false, reason: "当前审阅目录不是 Git 仓库" };
  }
  const gitRoot = selectedRoot.path;
  const branch = await getGitBranchInfo(gitRoot);
  if (!branch) return { available: false, reason: "当前仓库处于 detached HEAD，无法安全推送" };
  const head = (await runGitCommand(["rev-parse", "HEAD"], gitRoot))?.trim();
  const cachedPatch = await runGitCommand([
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--no-color",
  ], gitRoot);
  if (!head) {
    return { available: false, reason: "无法读取当前 Git 仓库状态" };
  }
  if (cachedPatch === null) {
    return { available: false, reason: `暂存区变更超过 ${MAX_GIT_COMMAND_OUTPUT_BYTES / 1024 / 1024}MB 补丁上限，请拆分提交` };
  }
  const [stagedPaths, unstagedPaths, untrackedPaths, worktreePatch] = await Promise.all([
    runGitCommand(["diff", "--cached", "--name-only", "-z"], gitRoot).then(parseNulPaths),
    runGitCommand(["diff", "--name-only", "-z"], gitRoot).then(parseNulPaths),
    runGitCommand(["ls-files", "--others", "--exclude-standard", "-z"], gitRoot).then(parseNulPaths),
    // worktree patch 超限（null）不阻断发布状态：仅提交已暂存内容不依赖它，
    // 指纹缺失时由 applyCodingRepositoryPublishAction 拦截 includeUnstagedChanges。
    runGitCommand(["diff", "HEAD", "--binary", "--full-index", "--no-color"], gitRoot),
  ]);
  let worktreeHashHex: string | undefined;
  if (worktreePatch !== null) {
    const sortedUntrackedPaths = [...untrackedPaths].sort((left, right) => left.localeCompare(right));
    const untrackedHashes = new Array<{ path: string; hash: string }>(sortedUntrackedPaths.length);
    let untrackedCursor = 0;
    const hashUntrackedFiles = async () => {
      while (untrackedCursor < sortedUntrackedPaths.length) {
        const index = untrackedCursor;
        untrackedCursor += 1;
        const path = sortedUntrackedPaths[index]!;
        untrackedHashes[index] = {
          path,
          hash: (await runGitCommand(["hash-object", "--", path], gitRoot))?.trim() ?? "missing",
        };
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(6, sortedUntrackedPaths.length) },
      hashUntrackedFiles,
    ));
    const worktreeHash = createHash("sha256").update(worktreePatch);
    for (const entry of untrackedHashes) {
      worktreeHash.update("\0").update(entry.path).update("\0").update(entry.hash);
    }
    worktreeHashHex = worktreeHash.digest("hex");
  }
  let ahead = 0;
  let behind = 0;
  if (branch.upstream) {
    const counts = (await runGitCommand(["rev-list", "--left-right", "--count", "HEAD...@{u}"], gitRoot))
      ?.trim()
      .split(/\s+/)
      .map(Number);
    if (counts?.length === 2) {
      ahead = Number.isFinite(counts[0]) ? counts[0]! : 0;
      behind = Number.isFinite(counts[1]) ? counts[1]! : 0;
    }
  }
  return {
    available: true,
    rootId: selectedRoot.repository.rootId,
    rootLabel: selectedRoot.repository.rootLabel,
    branch: branch.name,
    ...(branch.upstream ? { upstream: branch.upstream } : {}),
    head,
    indexHash: createHash("sha256").update(cachedPatch).digest("hex"),
    ...(worktreeHashHex ? { worktreeHash: worktreeHashHex } : {}),
    stagedCount: stagedPaths.length,
    unstagedCount: unstagedPaths.length,
    untrackedCount: untrackedPaths.length,
    ahead,
    behind,
    canCommit: stagedPaths.length > 0,
    canPush: Boolean(await getCurrentBranchPushTarget(gitRoot, branch.name)),
  };
}

export async function applyCodingRepositoryPublishAction(
  workspaceRoot: string,
  input: CodingRepositoryPublishActionInput,
  options: { roots?: Iterable<string> } = {},
): Promise<CodingRepositoryPublishActionResult> {
  const state = await getCodingRepositoryPublishState(workspaceRoot, {
    rootId: input.rootId,
    roots: options.roots,
  });
  if (!state.available) throw new Error(state.reason);
  if (state.branch !== input.expectedBranch) throw new Error("当前分支已变化，请刷新后重试");
  if (state.head !== input.expectedHead) throw new Error("仓库 HEAD 已变化，请刷新后重试");

  let commitHash: string | undefined;
  if (input.action !== "push") {
    if (state.indexHash !== input.expectedIndexHash) throw new Error("暂存区已变化，请刷新后重试");
    if (input.includeUnstagedChanges && !state.worktreeHash) {
      throw new Error(`工作区变更超过 ${MAX_GIT_COMMAND_OUTPUT_BYTES / 1024 / 1024}MB 补丁上限，请分次提交`);
    }
    if (input.includeUnstagedChanges && state.worktreeHash !== input.expectedWorktreeHash) {
      throw new Error("工作区已变化，请刷新后重试");
    }
    if (!state.canCommit && !input.includeUnstagedChanges) throw new Error("没有已暂存的变更可提交");
    if (
      input.includeUnstagedChanges
      && state.stagedCount + state.unstagedCount + state.untrackedCount === 0
    ) {
      throw new Error("没有可提交的变更");
    }
    const selectedRoot = await resolveCodingRepositoryRoot(workspaceRoot, {
      rootId: input.rootId,
      roots: options.roots,
    });
    if (!selectedRoot) throw new Error("找不到目标 Git 仓库");
    const originalIndexPatch = input.includeUnstagedChanges
      ? await runGitCommand(["diff", "--cached", "--binary", "--full-index", "--no-color"], selectedRoot.path)
      : null;
    try {
      if (input.includeUnstagedChanges) {
        await runGitAction(["add", "--all", "--", "."], selectedRoot.path);
      }
      await runGitAction(["commit", "-m", input.message.trim()], selectedRoot.path, undefined, GIT_PUBLISH_TIMEOUT_MS);
    } catch (cause) {
      if (input.includeUnstagedChanges && originalIndexPatch !== null) {
        try {
          await restoreGitIndex(selectedRoot.path, originalIndexPatch);
        } catch (restoreCause) {
          const actionError = cause instanceof Error ? cause.message : "Git commit 失败";
          const restoreError = restoreCause instanceof Error ? restoreCause.message : "未知错误";
          throw new Error(`${actionError}\n暂存区恢复失败：${restoreError}`);
        }
      }
      throw cause;
    }
    commitHash = (await runGitCommand(["rev-parse", "HEAD"], selectedRoot.path))?.trim();
    if (!commitHash || commitHash === state.head) throw new Error("Git commit 未生成新的提交");
  }

  const shouldPush = input.action === "push" || input.action === "commit_and_push";
  if (shouldPush) {
    const selectedRoot = await resolveCodingRepositoryRoot(workspaceRoot, {
      rootId: input.rootId,
      roots: options.roots,
    });
    if (!selectedRoot) throw new Error("找不到目标 Git 仓库");
    try {
      await pushCurrentBranch(selectedRoot.path);
    } catch (cause) {
      const message = sanitizeGitError(cause instanceof Error ? cause.message : "Git push 失败");
      if (!commitHash) throw new Error(message);
      return {
        state: await getCodingRepositoryPublishState(workspaceRoot, {
          rootId: input.rootId,
          roots: options.roots,
        }),
        commitHash,
        pushCompleted: false,
        error: message,
      };
    }
  }

  return {
    state: await getCodingRepositoryPublishState(workspaceRoot, {
      rootId: input.rootId,
      roots: options.roots,
    }),
    ...(commitHash ? { commitHash } : {}),
    pushCompleted: shouldPush,
  };
}

async function restoreGitIndex(gitRoot: string, patch: string): Promise<void> {
  await runGitAction(["reset", "--mixed", "HEAD"], gitRoot);
  if (patch.trim()) {
    await runGitAction(["apply", "--cached", "--whitespace=nowarn", "-"], gitRoot, patch);
  }
}

export async function getCodingDiffMedia(
  workspaceRoot: string,
  filePath: string,
  side: "before" | "after",
  options: {
    rootId?: string;
    roots?: Iterable<string>;
    reviewSource?: CodingReviewSource;
  } = {},
): Promise<CodingDiffMediaResult> {
  const discoveredRoots = await discoverCodingRoots([workspaceRoot, ...(options.roots ?? [])]);
  const selectedRoot = options.rootId
    ? discoveredRoots.find((candidate) => candidate.repository.rootId === options.rootId)
    : discoveredRoots[0];
  if (!selectedRoot) throw new Error(`找不到 Coding 根目录: ${options.rootId ?? workspaceRoot}`);
  const root = selectedRoot.path;
  const safePath = normalizeSafePath(root, filePath);
  if (!safePath) throw new Error("文件路径超出项目目录");
  const gitRoot = await findGitRoot(root);
  const reviewSpec = gitRoot ? await resolveGitReviewSpec(gitRoot, options.reviewSource) : null;
  const data = gitRoot && reviewSpec
    ? await readGitBufferSource(gitRoot, safePath, side === "before" ? reviewSpec.before : reviewSpec.after)
    : readFileBuffer(root, safePath);
  if (!data) throw new Error(side === "before" ? "文件没有可用的旧版本" : "文件没有可用的新版本");
  if (data.length > 15 * 1024 * 1024) throw new Error("媒体文件过大，无法预览");
  return {
    mediaType: mediaTypeForPath(safePath),
    size: data.length,
    dataBase64: data.toString("base64"),
  };
}

function extractPatchHunk(patch: string, hunkIndex = 0): string {
  const lines = normalizeLineEndings(patch).split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk < 0) throw new Error("Diff 不包含可操作的 hunk");
  const header = lines.slice(0, firstHunk);
  const starts = lines
    .map((line, index) => line.startsWith("@@ ") ? index : -1)
    .filter((index) => index >= 0);
  const start = starts[hunkIndex];
  if (start === undefined) throw new Error("目标 hunk 已不存在，请刷新后重试");
  const end = starts[hunkIndex + 1] ?? lines.length;
  return [...header, ...lines.slice(start, end), ""].join("\n");
}

function parseBlamePorcelain(output: string, remoteBase?: string): CodingBlameResult["lines"] {
  const lines = normalizeLineEndings(output).split("\n");
  const result: CodingBlameResult["lines"] = [];
  for (let index = 0; index < lines.length;) {
    const header = lines[index]?.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/i);
    if (!header) {
      index += 1;
      continue;
    }
    const commit = header[1]!;
    const lineNumber = Number(header[2]);
    let author = "未知作者";
    let authorTime: string | undefined;
    let summary: string | undefined;
    index += 1;
    while (index < lines.length && !lines[index]!.startsWith("\t")) {
      const line = lines[index]!;
      if (line.startsWith("author ")) author = line.slice(7);
      else if (line.startsWith("author-time ")) {
        const timestamp = Number(line.slice(12));
        if (Number.isFinite(timestamp)) authorTime = new Date(timestamp * 1000).toISOString();
      } else if (line.startsWith("summary ")) summary = line.slice(8);
      index += 1;
    }
    if (index < lines.length) index += 1;
    const committed = !/^0+$/.test(commit);
    result.push({
      lineNumber,
      commit,
      author,
      ...(authorTime ? { authorTime } : {}),
      ...(summary ? { summary } : {}),
      committed,
      ...(committed && remoteBase ? { commitUrl: `${remoteBase}${remoteBase.includes("gitlab") ? "/-/commit/" : "/commit/"}${commit}` } : {}),
    });
  }
  return result;
}

function normalizeRemoteUrl(remote: string): string | undefined {
  if (/^git@[^:]+:.+/.test(remote)) {
    const match = remote.match(/^git@([^:]+):(.+)$/);
    return match ? `https://${match[1]}/${match[2]!.replace(/\.git$/, "")}` : undefined;
  }
  if (remote.startsWith("ssh://git@")) {
    try {
      const url = new URL(remote);
      return `https://${url.hostname}${url.pathname.replace(/\.git$/, "")}`;
    } catch {
      return undefined;
    }
  }
  if (/^https?:\/\//.test(remote)) return remote.replace(/\.git$/, "").replace(/\/$/, "");
  return undefined;
}

function remoteProvider(remoteBase?: string): CodingFileOpenTargets["remoteProvider"] {
  if (!remoteBase) return undefined;
  try {
    const hostname = new URL(remoteBase).hostname.toLowerCase();
    if (hostname === "github.com" || hostname.endsWith(".github.com")) return "github";
    if (hostname === "gitlab.com" || hostname.includes("gitlab")) return "gitlab";
  } catch {
    return undefined;
  }
  return undefined;
}

async function resolveCodingRepositoryRoot(
  workspaceRoot: string,
  options: { rootId?: string; roots?: Iterable<string> },
) {
  const discoveredRoots = await discoverCodingRoots([workspaceRoot, ...(options.roots ?? [])]);
  return options.rootId
    ? discoveredRoots.find((candidate) => candidate.repository.rootId === options.rootId)
    : discoveredRoots[0];
}

async function getCurrentBranchPushTarget(
  gitRoot: string,
  branch: string,
): Promise<{ remote: string; destination: string; setUpstream: boolean } | null> {
  const configuredRemote = (await runGitCommand(["config", "--get", `branch.${branch}.remote`], gitRoot))?.trim();
  const configuredMerge = (await runGitCommand(["config", "--get", `branch.${branch}.merge`], gitRoot))?.trim();
  if (
    configuredRemote
    && configuredRemote !== "."
    && isSafeGitRemoteName(configuredRemote)
    && configuredMerge?.startsWith("refs/heads/")
  ) {
    const remoteExists = await runGitCommand(["remote", "get-url", configuredRemote], gitRoot);
    if (remoteExists) {
      return { remote: configuredRemote, destination: configuredMerge, setUpstream: false };
    }
  }
  const originExists = await runGitCommand(["remote", "get-url", "origin"], gitRoot);
  return originExists
    ? { remote: "origin", destination: `refs/heads/${branch}`, setUpstream: true }
    : null;
}

function isSafeGitRemoteName(remote: string): boolean {
  return /^[a-z0-9][a-z0-9._/-]*$/i.test(remote);
}

async function pushCurrentBranch(gitRoot: string): Promise<void> {
  const branch = await getGitBranchInfo(gitRoot);
  if (!branch) throw new Error("当前仓库处于 detached HEAD，无法安全推送");
  const target = await getCurrentBranchPushTarget(gitRoot, branch.name);
  if (!target) throw new Error("当前分支没有 upstream，且仓库未配置 origin");
  await runGitAction([
    "push",
    ...(target.setUpstream ? ["--set-upstream"] : []),
    target.remote,
    `HEAD:${target.destination}`,
  ], gitRoot, undefined, GIT_PUBLISH_TIMEOUT_MS);
}

function sanitizeGitError(message: string): string {
  return message.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1***@");
}

function readFileBuffer(root: string, filePath: string): Buffer | null {
  const safePath = normalizeSafePath(root, filePath);
  if (!safePath) return null;
  const target = resolve(root, safePath);
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  return readFileSync(target);
}

function fileFingerprint(root: string, filePath: string): string {
  const safePath = normalizeSafePath(root, filePath);
  if (!safePath) return "missing";
  const target = resolve(root, safePath);
  if (!existsSync(target)) return "missing";
  const metadata = statSync(target);
  if (!metadata.isFile()) return "missing";
  if (metadata.size > 15 * 1024 * 1024) return `${metadata.size}:${metadata.mtimeMs}`;
  return createHash("sha256").update(readFileSync(target)).digest("hex");
}

function mediaTypeForPath(path: string): string {
  const extension = path.toLowerCase().match(/\.([^.\\/]+)$/)?.[1];
  const types: Record<string, string> = {
    avif: "image/avif", bmp: "image/bmp", gif: "image/gif", ico: "image/x-icon",
    jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", tif: "image/tiff",
    tiff: "image/tiff", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}

export function createCodingMediaDiffPayload(
  input: Omit<CodingMediaDiffPayload, "kind" | "diffHash" | "actions"> & {
    patch: string;
    fingerprint?: string;
    actions?: CodingDiffActions;
  },
): CodingMediaDiffPayload {
  const { patch, fingerprint, actions = snapshotActions(), ...payload } = input;
  return {
    kind: "media",
    ...payload,
    actions,
    diffHash: hashDiff(input.path, input.status, patch, fingerprint ?? "", "", actions),
  };
}

export function createCodingBinaryDiffPayload(
  input: Omit<CodingBinaryDiffPayload, "kind" | "diffHash" | "actions"> & {
    patch: string;
    fingerprint?: string;
    actions?: CodingDiffActions;
  },
): CodingBinaryDiffPayload {
  const { patch, fingerprint, actions = snapshotActions(), ...payload } = input;
  return {
    kind: "binary",
    ...payload,
    actions,
    diffHash: hashDiff(input.path, input.status, patch, fingerprint ?? "", "", actions),
  };
}

async function getGitFileFingerprint(gitRoot: string, path: string): Promise<string> {
  const [before, after] = await Promise.all([
    runGitCommand(["rev-parse", `HEAD:${path}`], gitRoot),
    runGitCommand(["hash-object", "--", path], gitRoot),
  ]);
  return `${before?.trim() ?? "missing"}:${after?.trim() ?? "missing"}`;
}

function snapshotActions(): CodingDiffActions {
  return {
    isGit: false,
    staged: false,
    unstaged: true,
    canStage: false,
    canUnstage: false,
  };
}

function readOnlyGitActions(reason: string): CodingDiffActions {
  return {
    isGit: true,
    staged: false,
    unstaged: false,
    canStage: false,
    canUnstage: false,
    unavailableReason: reason,
  };
}

async function getGitDiffActions(root: string, path: string, status: RuntimeCodingFileChange["status"]): Promise<CodingDiffActions> {
  const [stagedPatch, unstagedPatch] = await Promise.all([
    runGitCommand(["diff", "--cached", "--no-ext-diff", "--no-color", "--", path], root),
    runGitCommand(["diff", "--no-ext-diff", "--no-color", "--", path], root),
  ]);
  const staged = Boolean(stagedPatch);
  const unstaged = Boolean(unstagedPatch) || status === "untracked";
  return {
    isGit: true,
    staged,
    unstaged,
    canStage: unstaged,
    canUnstage: staged,
  };
}

function hashDiff(
  path: string,
  status: RuntimeCodingFileChange["status"],
  patch: string,
  oldContent = "",
  newContent = "",
  actions?: CodingDiffActions,
): string {
  return createHash("sha256")
    .update(path)
    .update("\0")
    .update(status ?? "modified")
    .update("\0")
    .update(patch)
    .update("\0")
    .update(oldContent)
    .update("\0")
    .update(newContent)
    .update("\0")
    .update(actions ? JSON.stringify({
      staged: actions.staged,
      unstaged: actions.unstaged,
      canStage: actions.canStage,
      canUnstage: actions.canUnstage,
    }) : "")
    .digest("hex");
}

function createUnifiedPatch(path: string, oldContent: string, newContent: string): string {
  const oldLines = splitContentLines(oldContent);
  const newLines = splitContentLines(newContent);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function getRichMediaKind(path: string): "markdown" | "image" | "svg" | "pdf" | undefined {
  const extension = path.toLowerCase().match(/\.([^.\\/]+)$/)?.[1];
  if (["md", "markdown", "mdown", "mdx", "mkd"].includes(extension ?? "")) return "markdown";
  if (extension === "svg") return "svg";
  if (extension === "pdf") return "pdf";
  if (["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "tif", "tiff", "webp"].includes(extension ?? "")) return "image";
  return undefined;
}

function isKnownBinaryPath(path: string): boolean {
  return /\.(?:7z|a|avi|bin|class|dll|dylib|eot|exe|flac|gz|jar|m4a|mkv|mov|mp3|mp4|o|ogg|otf|so|tar|ttf|wav|webm|woff2?|xz|zip)$/i.test(path);
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
      realRoot = realpathSync.native(resolvedRoot);
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

/** 项目目录 Git 概要（输入框项目条展示）：目录不存在/非 Git 仓库返回 isGitRepo=false */
export async function getWorkspaceGitSummary(workspaceRoot: string): Promise<AgentWorkspaceGitInfo> {
  const [root] = await discoverCodingRoots([workspaceRoot]);
  if (!root || root.repository.kind !== "git") return { isGitRepo: false };
  const branch = root.repository.branch?.name;
  return { isGitRepo: true, ...(branch ? { branch } : {}) };
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
    return realpathSync.native(trimmed);
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

function matchesPathFilter(allowedPaths: Set<string>, path: string): boolean {
  if (allowedPaths.has("") || allowedPaths.has(".")) return true;
  let candidate = path;
  while (candidate) {
    if (allowedPaths.has(candidate)) return true;
    const separatorIndex = candidate.lastIndexOf("/");
    if (separatorIndex < 0) return false;
    candidate = candidate.slice(0, separatorIndex);
  }
  return false;
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
    resolvedRoot = realpathSync.native(resolve(root));
  } catch {
    resolvedRoot = resolve(root);
  }
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(resolvedRoot, filePath);
  if (filePath.split(/[\\/]/).includes("..")) return null;
  let realTarget: string;
  try {
    realTarget = realpathSync.native(target);
  } catch {
    try {
      realTarget = resolve(realpathSync.native(dirname(target)), basename(target));
    } catch {
      realTarget = target;
    }
  }
  const relativeRealPath = relative(resolvedRoot, realTarget).split(sep).join("/");
  if (!relativeRealPath || relativeRealPath === ".." || relativeRealPath.startsWith("../")) return null;
  return relativeRealPath;
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

async function readGitTextSource(
  root: string,
  filePath: string,
  source: GitReviewContentSource,
): Promise<string> {
  if (source.kind === "worktree") return readSafeContent(root, filePath);
  const spec = source.kind === "index" ? `:${filePath}` : `${source.ref}:${filePath}`;
  // 先以 cat-file -s 预检 blob 大小：>10MB 提前抛错，避免 git show 输出超水位被
  // runGitCommand 返回 null 后在此处静默成空串（与 10-16MB 区间的报错语义对齐）
  const blobSize = Number((await runGitCommand(["cat-file", "-s", spec], root))?.trim());
  if (Number.isFinite(blobSize) && blobSize > MAX_FILE_SIZE_BYTES) throw new Error("文件过大，无法生成 diff");
  const result = await runGitCommand(["show", spec], root);
  if (result === null) return "";
  if (Buffer.byteLength(result, "utf-8") > MAX_FILE_SIZE_BYTES) throw new Error("文件过大，无法生成 diff");
  return normalizeLineEndings(result);
}

async function readGitBufferSource(
  root: string,
  filePath: string,
  source: GitReviewContentSource,
): Promise<Buffer | null> {
  if (source.kind === "worktree") return readFileBuffer(root, filePath);
  return runGitBuffer(["show", source.kind === "index" ? `:${filePath}` : `${source.ref}:${filePath}`], root);
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
  if (SHOULD_ISOLATE_GIT_SPAWN) return runGitCommandInWorker(args, cwd);
  return runGitCommandInline(args, cwd);
}

// 生产 sidecar 走 Electron utilityProcess.fork（Node 运行时）时 SHOULD_ISOLATE_GIT_SPAWN=false，
// 本函数即生产路径；导出仅供测试钉死主线程版水位行为。
export function runGitCommandInline(args: string[], cwd: string): Promise<string | null> {
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
        // stderr 无人消费：pipe 会在 git 写满 OS 管道缓冲后挂死（如 Windows autocrlf 的逐文件告警），
        // 本函数从不读 stderr，直接丢弃（与 runGitBuffer/runGitSearchDiff 一致）。
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch {
      finish(null);
      return;
    }
    child.stdout?.setEncoding("utf8");
    let stdout = "";
    let stdoutBytes = 0;
    let outputDiscarded = false;
    child.stdout?.on("data", (chunk) => {
      if (outputDiscarded) return;
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes <= MAX_GIT_COMMAND_OUTPUT_BYTES) stdout += chunk;
      else {
        // 输出已废弃：SIGKILL 硬杀不等优雅退出，并丢弃 kill→close 窗口内的残余 chunk
        // （与 runGitSearchDiff 的 truncated 早退口径一致）
        outputDiscarded = true;
        child.kill("SIGKILL");
      }
    });
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
      finish(code === 0 && stdoutBytes <= MAX_GIT_COMMAND_OUTPUT_BYTES ? stdout : null);

    });
  });
}

function runGitCommandInWorker(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolveResult) => {
    let worker: Worker;
    try {
      worker = getGitCommandWorker();
    } catch {
      resolveResult(null);
      return;
    }
    const id = nextGitCommandId++;
    pendingGitCommands.set(id, { resolve: resolveResult, args, cwd });
    try {
      worker.postMessage({ id, args, cwd, timeoutMs: GIT_TIMEOUT_MS });
    } catch {
      pendingGitCommands.delete(id);
      resolveResult(null);
    }
  });
}

function getGitCommandWorker(): Worker {
  if (gitCommandWorker) return gitCommandWorker;
  const worker = new Worker(GIT_COMMAND_WORKER_SOURCE, { eval: true });
  worker.unref();
  worker.on("message", (message: { id: number; value: string | null; diag?: { reason: string; message: string } }) => {
    const pending = pendingGitCommands.get(message.id);
    if (!pending) return;
    pendingGitCommands.delete(message.id);
    // 异常终态（水位/超时/spawn 失败）必须留痕，否则与 git 真实故障在日志上不可区分（#594 review round5）
    if (message.diag) {
      log.warn("runGitCommand 异常终态", { reason: message.diag.reason, detail: message.diag.message, gitArgs: pending.args.slice(0, 3), cwd: pending.cwd });
    }
    pending.resolve(message.value);
  });
  const resetWorker = () => {
    if (gitCommandWorker !== worker) return;
    gitCommandWorker = undefined;
    for (const pending of pendingGitCommands.values()) pending.resolve(null);
    pendingGitCommands.clear();
  };
  worker.on("error", resetWorker);
  worker.on("exit", resetWorker);
  gitCommandWorker = worker;
  return worker;
}

function runGitSearchDiff(args: string[], cwd: string): Promise<{ output: string; truncated: boolean }> {
  return new Promise((resolveResult) => {
    let settled = false;
    let output = "";
    let outputBytes = 0;
    let truncated = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveResult({ output, truncated });
    };
    let child;
    try {
      child = spawn("git", ["-c", "core.quotePath=false", ...args], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch {
      finish();
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (truncated) return;
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (outputBytes + chunkBytes > MAX_REVIEW_SEARCH_OUTPUT_BYTES) {
        truncated = true;
        child.kill();
        return;
      }
      output += chunk;
      outputBytes += chunkBytes;
    });
    const timeout = setTimeout(() => {
      truncated = true;
      child.kill();
      finish();
    }, GIT_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timeout);
      finish();
    });
    child.on("close", () => {
      clearTimeout(timeout);
      finish();
    });
  });
}

function runGitAction(args: string[], cwd: string, stdin?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Git 操作超时"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveResult();
      else reject(new Error(stderr.trim() || `Git 操作失败 (${code ?? "unknown"})`));
    });
    child.stdin.end(stdin);
  });
}

function runGitBuffer(args: string[], cwd: string): Promise<Buffer | null> {
  return new Promise((resolveResult) => {
    const child = spawn("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => {
      child.kill();
      resolveResult(null);
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_GIT_COMMAND_OUTPUT_BYTES) chunks.push(chunk);
      else child.kill();
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolveResult(null);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveResult(code === 0 && size <= MAX_GIT_COMMAND_OUTPUT_BYTES ? Buffer.concat(chunks) : null);
    });
  });
}
