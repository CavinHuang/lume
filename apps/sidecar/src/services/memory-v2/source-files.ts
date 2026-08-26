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
  // 语义备案(#728 review):candidate 已 realpath 化,「scope 内 symlink → scope 内
  // 目标」的**直接路径访问**在此放行——内容仍被锁定在 scope 内,与 listing 侧
  // walkSourceTarget 跳过 symlink 不冲突(列表不展示、直达可读)。逐段 lstat 只拦
  // 相对路径中间段出现的 symlink;若需收紧为全拒,删掉上面的 realpath 归一即可。
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
  let canonical: string;
  try {
    canonical = realpathSync(target);
  } catch {
    // 竞态删除窗口：单条目标消失只跳过自身，不让整次 listing 失败
    return [];
  }
  if (!existsSync(target)) return [];
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) return [];
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) return [];
  if (stat.isFile()) return [toSourceFile(canonical, root, scopeId, stat.size, stat.mtime.toISOString())];
  if (!stat.isDirectory()) return [];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const child = `${target}${sep}${entry.name}`;
    if (entry.isSymbolicLink()) return [];
    return walkSourceTarget(child, root, scopeId);
  });
}

function toSourceFile(canonicalPath: string, root: string, scopeId: string, size: number, modifiedAt: string): MemorySourceFile {
  // 入参即 walkSourceTarget 已做过归属校验的 canonical 路径（root 同侧
  // realpath 规范化）：直接取 relative，避免对词法 path 二次 realpath 的
  // 冗余 syscall 与竞态下产出未复核路径的窗口。
  const relativePath = relative(root, canonicalPath).split(sep).join("/");
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
