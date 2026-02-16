/**
 * Path safety helpers for memory manager.
 * Extracted from memory-index-manager to keep manager focused on orchestration.
 */

import { relative, resolve } from "node:path";

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
