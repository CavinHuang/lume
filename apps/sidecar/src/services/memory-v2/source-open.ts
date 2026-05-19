import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { getMemoryV2ScopePaths } from "./paths";

export function openMemoryV2Source(input: {
  workspaceSlug: string;
  path: string;
}): { ok: true } {
  if (!existsSync(input.path)) {
    throw new Error("记忆来源不存在");
  }
  const target = realpathSync(input.path);
  const allowedRoots = [
    getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: input.workspaceSlug }).root,
    getMemoryV2ScopePaths({ scope: "global" }).root
  ].map((path) => realpathSync(path));
  if (!allowedRoots.some((root) => target === root || target.startsWith(`${root}${sep}`))) {
    throw new Error("记忆来源路径超出 Memory V2 目录");
  }
  openInSystem(target);
  return { ok: true };
}

function openInSystem(path: string): void {
  if (process.platform === "win32") {
    spawnDetached("cmd", ["/c", "start", "", path]);
    return;
  }
  if (process.platform === "darwin") {
    spawnDetached("open", [path]);
    return;
  }
  spawnDetached("xdg-open", [path]);
}

function spawnDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}
