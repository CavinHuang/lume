import { existsSync, realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import type { FileRef } from "@lume/shared";
import { getMemoryV2ScopePaths } from "./paths";

export function openMemoryV2Source(input: {
  workspaceSlug: string;
  path: string;
}): { ok: true; ref: FileRef } {
  if (!existsSync(input.path)) {
    throw new Error("记忆来源不存在");
  }
  const target = realpathSync(input.path);
  const allowedRoots = [
    { scopeId: `workspace:${input.workspaceSlug}`, root: realpathSync(getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: input.workspaceSlug }).root) },
    { scopeId: "global", root: realpathSync(getMemoryV2ScopePaths({ scope: "global" }).root) }
  ];
  const match = allowedRoots.find(({ root }) => target === root || target.startsWith(`${root}${sep}`));
  if (!match) {
    throw new Error("记忆来源路径超出 Memory V2 目录");
  }
  return {
    ok: true,
    ref: {
      source: "memory",
      scopeId: match.scopeId,
      relativePath: relative(match.root, target).split(sep).join("/")
    }
  };
}
