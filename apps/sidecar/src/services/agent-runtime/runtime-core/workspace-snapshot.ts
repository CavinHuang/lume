import { readdir, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { runGitCommand } from "./coding-change-service";

export interface WorkspaceFileSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
}

export interface WorkspaceSnapshot {
  version: 1;
  root: string;
  capturedAt: string;
  files: Record<string, WorkspaceFileSnapshot>;
}

export interface WorkspaceSnapshotDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "coverage",
  "out",
  "artifacts",
  "files",
  "plans",
  ".context"
]);

export async function captureWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const canonicalRoot = resolve(root);
  const files: Record<string, WorkspaceFileSnapshot> = {};
  const gitPaths = await listGitWorkspaceFiles(canonicalRoot);
  if (gitPaths) {
    for (const relativePath of gitPaths) await snapshotFile(canonicalRoot, relativePath, files);
  } else {
    await walk(canonicalRoot, canonicalRoot, files);
  }
  return {
    version: 1,
    root: canonicalRoot,
    capturedAt: new Date().toISOString(),
    files
  };
}

/**
 * 优先复用 git 的文件视图（tracked + untracked，排除 .gitignore 等标准忽略规则）。
 * git index 本身就是增量维护的文件状态库，交给它枚举可把 node_modules/target 等
 * 生成物天然挡在快照之外——硬编码排除表永远追不全生态（issue #90）。
 * 非 git 目录或 git 调用失败时返回 undefined，由调用方退回目录遍历。
 * 注意走 spawn 版 runGitCommand：bun 在 Windows 上 execFile 有秒级开销。
 */
async function listGitWorkspaceFiles(root: string): Promise<string[] | undefined> {
  const stdout = await runGitCommand(["ls-files", "-co", "--exclude-standard"], root);
  if (stdout === null) return undefined;
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function snapshotFile(
  root: string,
  relativePath: string,
  files: Record<string, WorkspaceFileSnapshot>
): Promise<void> {
  try {
    const metadata = await stat(resolve(root, relativePath));
    if (!metadata.isFile()) return;
    files[relativePath] = {
      path: relativePath,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      // 伪 hash：mtimeNs+size 足够判定"是否变化"（git index 的快速路径同理），
      // 免去逐文件读全文+sha256；内容级差异由 coding-change-service 的 git diff 负责。
      hash: `${metadata.mtimeNs}:${metadata.size}`
    };
  } catch {
    // 文件可能在枚举后消失；下一次快照会收敛。
  }
}

export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot | undefined,
  after: WorkspaceSnapshot
): WorkspaceSnapshotDiff {
  const previous = before?.files ?? {};
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [path, file] of Object.entries(after.files)) {
    const prior = previous[path];
    if (!prior) {
      added.push(path);
    } else if (prior.hash !== file.hash || prior.size !== file.size) {
      modified.push(path);
    }
  }
  for (const path of Object.keys(previous)) {
    if (!after.files[path]) deleted.push(path);
  }

  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort()
  };
}

export function flattenWorkspaceSnapshotDiff(diff: WorkspaceSnapshotDiff): string[] {
  return [...diff.added, ...diff.modified, ...diff.deleted];
}

async function walk(
  root: string,
  directory: string,
  files: Record<string, WorkspaceFileSnapshot>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolute, files);
      continue;
    }
    if (!entry.isFile()) continue;
    await snapshotFile(root, relative(root, absolute).split(sep).join("/"), files);
  }
}
