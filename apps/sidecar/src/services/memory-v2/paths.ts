import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  getStructuredMemoryDir,
  getWorkspaceMemoryDir
} from "../infra/config-paths";
import type { MemoryV2Scope } from "./types";

export interface MemoryV2ScopePaths {
  root: string;
  memoryMd: string;
  entriesDir: string;
  dailyDir: string;
  runsDir?: string;
  pendingDir: string;
  pendingConflictsDir: string;
  pendingStaleDir: string;
  pendingLowConfidenceDir: string;
}

export function getMemoryV2ScopePaths(input: {
  scope: MemoryV2Scope;
  workspaceSlug?: string;
}): MemoryV2ScopePaths {
  const root = input.scope === "global"
    ? getStructuredMemoryDir()
    : getWorkspaceMemoryDir(requireWorkspaceSlug(input.workspaceSlug));
  return ensureMemoryV2ScopePaths(root, input.scope);
}

export function ensureMemoryV2ScopePaths(root: string, scope: MemoryV2Scope): MemoryV2ScopePaths {
  const pendingDir = join(root, "pending");
  const paths: MemoryV2ScopePaths = {
    root,
    memoryMd: join(root, "MEMORY.md"),
    entriesDir: join(root, "entries"),
    dailyDir: join(root, "daily"),
    ...(scope === "workspace" ? { runsDir: join(root, "runs") } : {}),
    pendingDir,
    pendingConflictsDir: join(pendingDir, "conflicts"),
    pendingStaleDir: join(pendingDir, "stale"),
    pendingLowConfidenceDir: join(pendingDir, "low-confidence")
  };
  for (const dir of [
    paths.root,
    paths.entriesDir,
    paths.dailyDir,
    paths.runsDir,
    paths.pendingDir,
    paths.pendingConflictsDir,
    paths.pendingStaleDir,
    paths.pendingLowConfidenceDir
  ]) {
    if (dir) mkdirSync(dir, { recursive: true });
  }
  return paths;
}

function requireWorkspaceSlug(workspaceSlug?: string): string {
  const trimmed = workspaceSlug?.trim();
  if (!trimmed) {
    throw new Error("workspaceSlug is required for workspace memory");
  }
  return trimmed;
}
