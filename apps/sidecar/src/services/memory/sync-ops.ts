/**
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/test/openclaw/src/memory/manager-sync-ops.ts
 * Adaptation:
 * - Keep lightweight sync helpers for Lume's built-in memory manager.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { collectMarkdownFiles, isMarkdownFile } from "../openclaw/memory-path-utils";

export interface SyncTargetEntry {
  source: "memory" | "session";
  logicalPath: string;
  absPath: string;
  content: string;
  mtimeMs: number;
  size: number;
  lineMap?: number[];
}

export function collectWorkspaceMemoryEntries(params: {
  workspaceRoot: string;
  extraPaths: string[];
}): SyncTargetEntry[] {
  const memoryFiles = new Map<string, string>();
  const addCandidateFile = (absPath: string): void => {
    if (!existsSync(absPath)) return;
    const st = lstatSync(absPath);
    if (st.isSymbolicLink() || !st.isFile()) return;
    let canonical = resolve(absPath);
    try {
      canonical = realpathSync(absPath);
    } catch {
      canonical = resolve(absPath);
    }
    if (!memoryFiles.has(canonical)) {
      memoryFiles.set(canonical, resolve(absPath));
    }
  };

  addCandidateFile(resolve(params.workspaceRoot, "MEMORY.md"));
  addCandidateFile(resolve(params.workspaceRoot, "memory.md"));

  const memoryDir = resolve(params.workspaceRoot, "memory");
  for (const file of collectMarkdownFiles(memoryDir)) {
    addCandidateFile(file);
  }
  for (const extraPath of params.extraPaths) {
    if (!existsSync(extraPath)) continue;
    const st = lstatSync(extraPath);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const file of collectMarkdownFiles(extraPath)) {
        addCandidateFile(file);
      }
      continue;
    }
    if (st.isFile() && isMarkdownFile(extraPath)) {
      addCandidateFile(extraPath);
    }
  }

  const entries: SyncTargetEntry[] = [];
  for (const absPath of memoryFiles.values()) {
    const stat = statSync(absPath);
    const content = readFileSync(absPath, "utf-8");
    let logicalPath = relative(params.workspaceRoot, absPath).replace(/\\/g, "/");
    if (logicalPath.startsWith("..")) {
      logicalPath = `extra:${resolve(absPath).replace(/\\/g, "/")}`;
    }
    entries.push({
      source: "memory",
      logicalPath,
      absPath: resolve(absPath),
      content,
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  }

  return entries;
}

export function pruneStaleIndexedRows(params: {
  db: Database;
  workspaceSlug: string;
  targetPaths: Set<string>;
  onDeletePath: (path: string) => void;
}): void {
  const indexedRows = params.db
    .query(
      `SELECT path, source FROM files
       WHERE workspace_slug = ?1`
    )
    .all(params.workspaceSlug) as Array<{ path: string; source: string }>;
  for (const row of indexedRows) {
    if (!params.targetPaths.has(row.path) && (row.source === "memory" || row.source === "session")) {
      params.onDeletePath(row.path);
      params.db.query("DELETE FROM files WHERE path = ?1").run(row.path);
    }
  }
}
