/**
 * Migrated from:
 * earlier memory path utility implementation
 * Adaptation:
 * - Expose memory path helpers for Lume memory services.
 * - Keep behavior aligned with existing Lume memory path rules.
 */

import { resolve, relative } from "node:path";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { extname } from "node:path";

export function normalizeRelPath(value: string): string {
  const trimmed = value.trim().replace(/^[./]+/, "");
  return trimmed.replace(/\\/g, "/");
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (normalized === "MEMORY.md") {
    return true;
  }
  return /^memory\/\d{4}-\d{2}-\d{2}\.md$/i.test(normalized);
}

export function normalizeExtraMemoryPaths(workspaceRoot: string, extraPaths: string[]): string[] {
  const resolved = extraPaths
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(workspaceRoot, value));
  return Array.from(new Set(resolved));
}

// ─── Path safety helpers (migrated from path-ops.ts) ───

export function ensureInsideRoot(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || rel.startsWith("../") || rel === "..") {
    throw new Error("目标路径超出工作区允许范围");
  }
  return resolvedTarget;
}

export function ensurePathAllowed(params: {
  workspaceRoot: string;
  absPath: string;
  extraRoots: string[];
}): void {
  const resolvedTarget = resolve(params.absPath);
  const resolvedWorkspace = resolve(params.workspaceRoot);
  const relWorkspace = relative(resolvedWorkspace, resolvedTarget);
  if (!relWorkspace.startsWith("..") && relWorkspace !== "..") return;

  for (const extraRoot of params.extraRoots) {
    const rel = relative(extraRoot, resolvedTarget);
    if (!rel.startsWith("..") && rel !== "..") {
      return;
    }
  }

  throw new Error("目标路径超出允许范围");
}

export function isMarkdownFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".md" || ext === ".markdown";
}

export function collectMarkdownFiles(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  const rootStat = lstatSync(baseDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];

  const entries = readdirSync(baseDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = resolve(baseDir, entry.name);
    const st = lstatSync(fullPath);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      files.push(...collectMarkdownFiles(fullPath));
      continue;
    }
    if (st.isFile() && isMarkdownFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}
