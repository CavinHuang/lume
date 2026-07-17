import { constants, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const WINDOWS_REPARSE_POINT = 0x400;

export function assertWikiSegment(value: string, label = "path segment"): string {
  const segment = value.trim();
  if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
    throw new Error(`${label} 非法`);
  }
  if (!/^[\p{L}\p{N}._-]+$/u.test(segment)) throw new Error(`${label} 包含非法字符`);
  return segment;
}

export function assertWikiUuid(value: string, label = "workspace id"): string {
  const id = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`${label} 必须是 UUID`);
  }
  return id;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isReparsePoint(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isSymbolicLink() || ((stat.mode & WINDOWS_REPARSE_POINT) === WINDOWS_REPARSE_POINT);
}

/**
 * Resolve a path under the vault while checking every existing component. This
 * is deliberately used for reads as well as writes because the vault is
 * editable by external applications.
 */
export function resolveWikiPath(rootInput: string, relativePath = "", options: { createRoot?: boolean } = {}): string {
  const root = resolve(rootInput);
  if (!existsSync(root)) {
    if (!options.createRoot) throw new Error("Wiki root 不存在");
    mkdirSync(root, { recursive: true });
  }
  if (isReparsePoint(root)) throw new Error("Wiki root 不能是符号链接或 reparse point");
  const canonicalRoot = realpathSync.native(root);
  const candidate = resolve(root, relativePath);
  if (!isContained(root, candidate)) throw new Error("Wiki 路径越界");

  const rel = relative(root, candidate);
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    if (isReparsePoint(cursor)) throw new Error(`Wiki 路径包含符号链接或 reparse point: ${segment}`);
    const canonical = realpathSync.native(cursor);
    if (!isContained(canonicalRoot, canonical)) throw new Error("Wiki canonical 路径越界");
  }
  return candidate;
}

export function ensureWikiDirectory(root: string, relativePath: string): string {
  const target = resolveWikiPath(root, relativePath, { createRoot: true });
  const missing: string[] = [];
  let cursor = target;
  while (!existsSync(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  resolveWikiPath(root, relative(root, cursor));
  for (const path of missing.reverse()) {
    mkdirSync(path);
    resolveWikiPath(root, relative(root, path));
  }
  return target;
}

export function assertExternalPathWithin(rootInput: string, pathInput: string): string {
  const root = realpathSync.native(resolve(rootInput));
  const path = resolve(pathInput);
  if (!isContained(root, path)) throw new Error("外部文件路径越界");
  const rel = relative(root, path);
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) throw new Error("外部文件不存在");
    if (isReparsePoint(cursor)) throw new Error("拒绝读取符号链接、junction 或 reparse point");
    const canonical = realpathSync.native(cursor);
    if (!isContained(root, canonical)) throw new Error("外部 canonical 路径越界");
  }
  return realpathSync.native(path);
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
