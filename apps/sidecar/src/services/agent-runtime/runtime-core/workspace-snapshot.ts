import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

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
  await walk(canonicalRoot, canonicalRoot, files);
  return {
    version: 1,
    root: canonicalRoot,
    capturedAt: new Date().toISOString(),
    files
  };
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
    } else if (prior.hash !== file.hash || prior.size !== file.size || prior.mtimeMs !== file.mtimeMs) {
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
    try {
      const metadata = await stat(absolute);
      const content = await readFile(absolute);
      const path = relative(root, absolute).split(sep).join("/");
      files[path] = {
        path,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        hash: createHash("sha256").update(content).digest("hex")
      };
    } catch {
      // Files can disappear while a command is running; the next snapshot will settle it.
    }
  }
}
