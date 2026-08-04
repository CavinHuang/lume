import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { getPersonaPath } from "./paths";
import type { MemoryV2Scope } from "./types";

export { getPersonaPath };

export function readPersonaRaw(scope: MemoryV2Scope, workspaceSlug?: string): string | null {
  const path = getPersonaPath(scope, workspaceSlug);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function writePersona(
  scope: MemoryV2Scope,
  workspaceSlug: string | undefined,
  markdown: string
): void {
  const path = getPersonaPath(scope, workspaceSlug);
  writePersonaAtomic(path, markdown);
}

export function deletePersona(scope: MemoryV2Scope, workspaceSlug?: string): void {
  rmSync(getPersonaPath(scope, workspaceSlug), { force: true });
}

/**
 * persona 存储当前无内存缓存（每次直读盘）；保留此钩子供后续任务加入缓存时清空。
 */
export function resetPersonaStoreForTest(): void {
  // no-op until an in-memory cache layer is introduced
}

function writePersonaAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const hash = createHash("sha1")
    .update(`${path}:${content}:${Date.now()}`)
    .digest("hex")
    .slice(0, 8);
  const tempPath = `${path}.tmp.${hash}`;
  writeFileSync(tempPath, content, "utf-8");
  renameSync(tempPath, path);
}
