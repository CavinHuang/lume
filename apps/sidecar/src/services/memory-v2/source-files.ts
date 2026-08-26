import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FileRef, MemorySourceFile, MemorySourceFilesPage } from "@lume/shared";
import { getMemoryV2ScopePaths } from "./paths";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export function listMemorySourceFiles(input: {
  workspaceSlug: string;
  cursor?: string;
  limit?: number;
}): MemorySourceFilesPage {
  const entries = [
    ...listScope("workspace", input.workspaceSlug),
    ...listScope("global"),
  ].sort((left, right) => fileRefSortKey(left.ref).localeCompare(fileRefSortKey(right.ref)));
  const offset = decodeCursor(input.cursor);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, input.limit ?? DEFAULT_PAGE_SIZE));
  const page = entries.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    entries: page,
    ...(nextOffset < entries.length ? { nextCursor: String(nextOffset) } : {}),
  };
}

export function listMemorySourceFilesForScope(scopeId: string): MemorySourceFile[] {
  if (scopeId === "global") return listScope("global");
  if (scopeId.startsWith("workspace:") && scopeId.length > "workspace:".length) {
    return listScope("workspace", scopeId.slice("workspace:".length));
  }
  throw new Error("Invalid memory source scopeId");
}

export function memoryFileRefForPath(input: {
  scope: "workspace" | "global";
  workspaceSlug?: string;
  path: string;
}): FileRef | undefined {
  const paths = getMemoryV2ScopePaths({ scope: input.scope, workspaceSlug: input.workspaceSlug });
  const root = realpathSync(paths.root);
  const withoutLines = input.path.replace(/#L\d+(?:-L?\d+)?$/i, "");
  let candidate = resolve(isAbsolute(withoutLines) ? withoutLines : resolve(root, withoutLines));
  // 入参可能是词法路径而 root 已 realpath 化（macOS tmpdir /var→/private/var）：
  // 归属判定前先把 candidate 规范化到同一口径，否则合法文件被误判为 scope 外
  if (!existsSync(candidate)) return undefined;
  candidate = realpathSync(candidate);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;

  let cursor = root;
  for (const part of relative(root, candidate).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) return undefined;
  }
  const canonical = candidate;
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) return undefined;
  if (!lstatSync(canonical).isFile()) return undefined;
  return {
    source: "memory",
    scopeId: input.scope === "workspace" ? `workspace:${input.workspaceSlug!}` : "global",
    relativePath: relative(root, canonical).split(sep).join("/"),
  };
}

function listScope(scope: "workspace" | "global", workspaceSlug?: string): MemorySourceFile[] {
  const paths = getMemoryV2ScopePaths({ scope, workspaceSlug });
  const root = realpathSync(paths.root);
  const scopeId = scope === "workspace" ? `workspace:${workspaceSlug!}` : "global";
  const targets = [paths.memoryMd, paths.entriesDir, paths.dailyDir, paths.runsDir].filter((path): path is string => Boolean(path));
  return targets.flatMap((target) => walkSourceTarget(target, root, scopeId));
}

function walkSourceTarget(target: string, root: string, scopeId: string): MemorySourceFile[] {
  if (!existsSync(target)) return [];
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return [];
  const canonical = realpathSync(target);
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) return [];
  if (stat.isFile()) return [toSourceFile(target, root, scopeId, stat.size, stat.mtime.toISOString())];
  if (!stat.isDirectory()) return [];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = `${target}${sep}${entry.name}`;
    if (entry.isSymbolicLink()) return [];
    return walkSourceTarget(child, root, scopeId);
  });
}

function toSourceFile(path: string, root: string, scopeId: string, size: number, modifiedAt: string): MemorySourceFile {
  // root 经 realpath 规范化而 path 仍是探测时的词法形态（macOS tmpdir
  // /var→/private/var）：relative 前必须同侧规范化，否则产出 ../.. 爬出目录的
  // 相对路径，ref 与 memoryFileRefForPath 的口径分裂。
  const relativePath = relative(root, realpathSync(path)).split(sep).join("/");
  return {
    ref: {
      source: "memory",
      scopeId,
      relativePath,
    },
    size,
    modifiedAt,
  };
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid memory source files cursor");
  return value;
}

function fileRefSortKey(ref: FileRef): string {
  return `${ref.scopeId}/${ref.relativePath}`;
}
