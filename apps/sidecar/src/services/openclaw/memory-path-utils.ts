/**
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/test/openclaw/src/memory/internal.ts
 * Adaptation:
 * - Expose memory path helpers for Lume sidecar services.
 * - Keep behavior aligned with OpenClaw memory path rules.
 */

import { resolve } from "node:path";
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
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return true;
  }
  return normalized.startsWith("memory/");
}

export function normalizeExtraMemoryPaths(workspaceRoot: string, extraPaths: string[]): string[] {
  const resolved = extraPaths
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(workspaceRoot, value));
  return Array.from(new Set(resolved));
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
