/**
 * FileRef 授权/守护层(#177 自 agent-files-service.ts 拆出,纯移动):
 * guarded FileRef 绑定校验、授权解析、读写与文本文档编解码。
 * watcher/rename/move/delete 等变更操作仍留在 agent-files-service.ts。
 */
import {
  existsSync,
  lstatSync,
  renameSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  FileEntry,
  FileRef,
  FileRefReadResult,
  FileReferenceBinding,
  GuardedFileRef,
  GuardedFileRefErrorCode,
  GuardedFileRefValidationResult,
  WriteFileRefInput,
  WriteFileRefResult,
} from "@lume/shared";
import { getAgentFileContextRootPath } from "../infra/config-paths";
import { getMemoryV2ScopePaths } from "../memory-v2/paths";
import { resolveAgentThreadWorkdir } from "./agent-workdir-resolver";
import { getAgentThreadMeta } from "./agent-thread-manager";
import {
  getAgentWorkspace,
  getAgentWorkspaceBySlug,
} from "./agent-workspace-manager";
import {
  isWithin,
  resolveWorkspaceResourcesDir,
  validatePathSegment,
} from "./agent-file-paths";

export interface ResolvedAuthorizedFileRef {
  ref: FileRef;
  relativePath: string;
  rootPath: string;
  absolutePath: string;
}

export class GuardedFileRefError extends Error {
  constructor(
    readonly code: GuardedFileRefErrorCode,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "GuardedFileRefError";
  }
}

export class AuthorizedFileRefError extends Error {
  constructor(
    readonly code: Exclude<
      GuardedFileRefErrorCode,
      "BINDING_CHANGED" | "KIND_MISMATCH"
    >,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizedFileRefError";
  }
}

export function createProjectRootFingerprint(projectRoot: string): string {
  const canonical = realpathSync(projectRoot);
  const platformKey =
    process.platform === "win32" ? canonical.toLowerCase() : canonical;
  return createHash("sha256").update(platformKey).digest("hex");
}

export function createFileReferenceBinding(
  threadId: string,
): FileReferenceBinding {
  const thread = getAgentThreadMeta(threadId);
  if (!thread) throw new Error(`Agent 线程不存在: ${threadId}`);
  const workdir = resolveAgentThreadWorkdir(threadId);
  const workspace = thread.workspaceId
    ? getAgentWorkspace(thread.workspaceId)
    : undefined;
  return {
    ...(workspace?.slug ? { workspaceSlug: workspace.slug } : {}),
    ...(workdir.projectRoot
      ? {
          projectRootFingerprint: createProjectRootFingerprint(
            workdir.projectRoot,
          ),
        }
      : {}),
    fileContextId: workdir.fileContextId,
  };
}

export function resolveGuardedFileRef(
  guarded: GuardedFileRef,
): ResolvedAuthorizedFileRef {
  assertCurrentGuardBinding(guarded);
  try {
    const resolved = resolveAuthorizedFileRef(guarded.ref);
    const isDirectory = statSync(resolved.absolutePath).isDirectory();
    if ((guarded.expectedKind === "directory") !== isDirectory) {
      throw new GuardedFileRefError(
        "KIND_MISMATCH",
        guarded.expectedKind === "directory" ? "目标不是目录" : "目标不是文件",
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof GuardedFileRefError) throw error;
    if (error instanceof AuthorizedFileRefError)
      throw new GuardedFileRefError(error.code, error.message);
    throw new GuardedFileRefError(
      "IO_ERROR",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function assertCurrentGuardBinding(guarded: GuardedFileRef): void {
  const thread = getAgentThreadMeta(guarded.guard.consumerThreadId);
  if (!thread)
    throw new GuardedFileRefError("UNAVAILABLE", "引用所属线程不可用");
  if (guarded.guard.kind === "session") {
    if (
      guarded.ref.source !== "session" ||
      guarded.ref.scopeId !== guarded.guard.expectedFileContextId
    ) {
      throw new GuardedFileRefError("OUT_OF_SCOPE", "会话引用与 guard 不一致");
    }
    const currentFileContextId = thread.fileContextId?.trim() || thread.id;
    if (currentFileContextId !== guarded.guard.expectedFileContextId) {
      throw new GuardedFileRefError(
        "BINDING_CHANGED",
        "引用来自原会话，当前线程文件上下文已改变",
      );
    }
    return;
  }
  if (
    guarded.ref.source !== "project" ||
    guarded.ref.scopeId !== guarded.guard.workspaceSlug
  ) {
    throw new GuardedFileRefError("OUT_OF_SCOPE", "项目引用与 guard 不一致");
  }
  const workspace = thread.workspaceId
    ? getAgentWorkspace(thread.workspaceId)
    : undefined;
  if (
    !workspace ||
    workspace.slug !== guarded.guard.workspaceSlug ||
    !workspace.projectPath
  ) {
    throw new GuardedFileRefError("BINDING_CHANGED", "线程项目绑定已改变");
  }
  let fingerprint: string;
  try {
    fingerprint = createProjectRootFingerprint(workspace.projectPath);
  } catch {
    throw new GuardedFileRefError("UNAVAILABLE", "当前项目目录不可用");
  }
  if (fingerprint !== guarded.guard.expectedProjectRootFingerprint) {
    throw new GuardedFileRefError("BINDING_CHANGED", "项目根目录绑定已改变");
  }
}

export function validateGuardedFileRef(
  guarded: GuardedFileRef,
): GuardedFileRefValidationResult {
  try {
    return {
      ok: true,
      entry: statResolvedFileRef(resolveGuardedFileRef(guarded)),
    };
  } catch (error) {
    const guardedError =
      error instanceof GuardedFileRefError
        ? error
        : new GuardedFileRefError(
            "IO_ERROR",
            error instanceof Error ? error.message : String(error),
          );
    return {
      ok: false,
      code: guardedError.code,
      message: guardedError.message.replace(/^\[[A-Z_]+\]\s*/, ""),
    };
  }
}

export function statGuardedFileRef(guarded: GuardedFileRef): FileEntry {
  return statResolvedFileRef(resolveGuardedFileRef(guarded));
}

export function readGuardedFileRef(
  guarded: GuardedFileRef,
): Extract<FileRefReadResult, { kind: "text" }> {
  const resolved = resolveGuardedFileRef(guarded);
  if (!statSync(resolved.absolutePath).isFile())
    throw new GuardedFileRefError("KIND_MISMATCH", "目标不是文件");
  const result = readFileRefDocument(resolved, false);
  if (result.kind !== "text")
    throw new GuardedFileRefError("KIND_MISMATCH", "目标不是可预览文本文件");
  return result;
}

export function normalizeAuthorizedRelativePath(input: string): string {
  if (
    input.includes("\0") ||
    isAbsolute(input) ||
    /^[a-zA-Z]:/.test(input) ||
    input.startsWith("\\\\")
  ) {
    throw new AuthorizedFileRefError(
      "OUT_OF_SCOPE",
      "FileRef 路径必须是安全相对路径",
    );
  }
  const parts: string[] = [];
  for (const part of input.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..")
      throw new AuthorizedFileRefError(
        "OUT_OF_SCOPE",
        "FileRef 路径不能越过授权根目录",
      );
    parts.push(part);
  }
  return parts.join("/");
}

export function resolveFileRefRoot(ref: FileRef): string {
  validatePathSegment(ref.scopeId.replace(/^workspace:/, ""), "scopeId");
  if (ref.source === "session") return getAgentFileContextRootPath(ref.scopeId);
  if (ref.source === "legacy") return resolveWorkspaceResourcesDir(ref.scopeId);
  if (ref.source === "project") {
    const workspace = getAgentWorkspaceBySlug(ref.scopeId);
    if (!workspace?.projectPath)
      throw new AuthorizedFileRefError("UNAVAILABLE", "项目尚未绑定本地目录");
    return workspace.projectPath;
  }
  if (ref.scopeId === "global")
    return getMemoryV2ScopePaths({ scope: "global" }).root;
  if (ref.scopeId.startsWith("workspace:")) {
    return getMemoryV2ScopePaths({
      scope: "workspace",
      workspaceSlug: ref.scopeId.slice("workspace:".length),
    }).root;
  }
  throw new AuthorizedFileRefError(
    "OUT_OF_SCOPE",
    "memory FileRef scopeId 非法",
  );
}

/** Resolve a renderer-safe FileRef and reject symlink/junction traversal at every existing segment. */
export function resolveAuthorizedFileRef(
  ref: FileRef,
): ResolvedAuthorizedFileRef {
  const relativePath = normalizeAuthorizedRelativePath(ref.relativePath);
  const lexicalRoot = resolve(resolveFileRefRoot(ref));
  if (!existsSync(lexicalRoot))
    throw new AuthorizedFileRefError("UNAVAILABLE", "FileRef 授权根目录不存在");
  let rootPath: string;
  try {
    rootPath = realpathSync(lexicalRoot);
  } catch (error) {
    throw mapAuthorizedFileSystemError(
      error,
      "FileRef 授权根目录不可用",
      "UNAVAILABLE",
    );
  }
  let cursor = rootPath;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor))
      throw new AuthorizedFileRefError("NOT_FOUND", "FileRef 目标不存在");
    try {
      if (lstatSync(cursor).isSymbolicLink())
        throw new AuthorizedFileRefError(
          "OUT_OF_SCOPE",
          "FileRef 不允许符号链接或 junction",
        );
    } catch (error) {
      if (error instanceof AuthorizedFileRefError) throw error;
      throw mapAuthorizedFileSystemError(error, "FileRef 目标不可用");
    }
  }
  let absolutePath: string;
  try {
    absolutePath = relativePath ? realpathSync(cursor) : rootPath;
  } catch (error) {
    throw mapAuthorizedFileSystemError(error, "FileRef 目标不可用");
  }
  if (!isWithin(rootPath, absolutePath))
    throw new AuthorizedFileRefError(
      "OUT_OF_SCOPE",
      "FileRef 目标超出授权根目录",
    );
  return {
    ref: { ...ref, relativePath },
    relativePath,
    rootPath,
    absolutePath,
  };
}

/** Resolve BrowserClient upload inputs against the current thread's project/session roots. */
export function resolveAuthorizedBrowserUploadPaths(
  threadId: string,
  inputs: string[],
): string[] {
  const thread = getAgentThreadMeta(threadId);
  if (!thread)
    throw new AuthorizedFileRefError("UNAVAILABLE", "浏览器上传所属线程不可用");
  const fileContextId = thread.fileContextId?.trim() || thread.id;
  const workspace = thread.workspaceId
    ? getAgentWorkspace(thread.workspaceId)
    : undefined;
  const roots = [
    ...(workspace?.projectPath
      ? [
          {
            source: "project" as const,
            scopeId: workspace.slug,
            root: realpathSync(workspace.projectPath),
          },
        ]
      : []),
    {
      source: "session" as const,
      scopeId: fileContextId,
      root: realpathSync(getAgentFileContextRootPath(fileContextId)),
    },
  ];
  return inputs.slice(0, 20).map((input) => {
    const encoded = input.startsWith("lume-file-ref:")
      ? input.slice("lume-file-ref:".length)
      : "";
    let ref: FileRef | undefined;
    if (encoded) {
      try {
        const parsed = JSON.parse(
          Buffer.from(encoded, "base64url").toString("utf8"),
        ) as Partial<FileRef>;
        if (
          (parsed.source === "project" || parsed.source === "session") &&
          typeof parsed.scopeId === "string" &&
          typeof parsed.relativePath === "string"
        ) {
          ref = {
            source: parsed.source,
            scopeId: parsed.scopeId,
            relativePath: parsed.relativePath,
          };
        }
      } catch {
        /* malformed references remain unauthorized */
      }
      if (!ref)
        throw new AuthorizedFileRefError(
          "OUT_OF_SCOPE",
          "浏览器上传 FileRef 非法",
        );
    } else {
      const candidateInput = input.trim();
      if (!candidateInput)
        throw new AuthorizedFileRefError("OUT_OF_SCOPE", "浏览器上传路径为空");
      for (const root of roots) {
        const candidate = resolve(
          isAbsolute(candidateInput)
            ? candidateInput
            : join(root.root, candidateInput),
        );
        if (!isWithin(root.root, candidate)) continue;
        ref = {
          source: root.source,
          scopeId: root.scopeId,
          relativePath: relative(root.root, candidate).split(sep).join("/"),
        };
        break;
      }
      if (!ref)
        throw new AuthorizedFileRefError(
          "OUT_OF_SCOPE",
          "浏览器上传路径不属于当前任务",
        );
    }
    if (
      ref.source === "project" &&
      (!workspace || ref.scopeId !== workspace.slug)
    ) {
      throw new AuthorizedFileRefError(
        "OUT_OF_SCOPE",
        "浏览器上传项目引用与当前任务不一致",
      );
    }
    if (ref.source === "session" && ref.scopeId !== fileContextId) {
      throw new AuthorizedFileRefError(
        "OUT_OF_SCOPE",
        "浏览器上传会话引用与当前任务不一致",
      );
    }
    const resolved = resolveAuthorizedFileRef(ref);
    const metadata = lstatSync(resolved.absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new AuthorizedFileRefError(
        "OUT_OF_SCOPE",
        "浏览器上传目标必须是普通文件",
      );
    if (metadata.size > 100 * 1024 * 1024)
      throw new AuthorizedFileRefError(
        "OUT_OF_SCOPE",
        "浏览器上传文件超过 100 MB",
      );
    return resolved.absolutePath;
  });
}

function mapAuthorizedFileSystemError(
  error: unknown,
  fallbackMessage: string,
  fallbackCode: AuthorizedFileRefError["code"] = "IO_ERROR",
): AuthorizedFileRefError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (code === "ENOENT" || code === "ENOTDIR")
    return new AuthorizedFileRefError("NOT_FOUND", fallbackMessage);
  if (code === "EACCES" || code === "EPERM")
    return new AuthorizedFileRefError("OUT_OF_SCOPE", fallbackMessage);
  return new AuthorizedFileRefError(fallbackCode, fallbackMessage);
}

export function listAuthorizedFileRefDirectory(ref: FileRef): FileEntry[] {
  const resolved = resolveAuthorizedFileRef(ref);
  if (!statSync(resolved.absolutePath).isDirectory())
    throw new Error("FileRef 目标不是目录");
  return listResolvedDirectory(resolved);
}

function listResolvedDirectory(
  resolved: ResolvedAuthorizedFileRef,
): FileEntry[] {
  const entries = readdirSync(resolved.absolutePath, {
    withFileTypes: true,
  }).map(
    (entry) =>
      ({
        name: entry.name,
        path: join(resolved.absolutePath, entry.name),
        isDirectory: entry.isDirectory(),
      }) satisfies FileEntry,
  );
  entries.sort((left, right) =>
    left.isDirectory === right.isDirectory
      ? left.name.localeCompare(right.name, "en")
      : left.isDirectory
        ? -1
        : 1,
  );
  return entries.map((entry) =>
    enrichEntryWithFileRef(
      entry,
      resolved.rootPath,
      resolved.ref.source,
      resolved.ref.scopeId,
    ),
  );
}

export function statAuthorizedFileRef(ref: FileRef): FileEntry {
  return statResolvedFileRef(resolveAuthorizedFileRef(ref));
}

function statResolvedFileRef(resolved: ResolvedAuthorizedFileRef): FileEntry {
  const metadata = lstatSync(resolved.absolutePath);
  return {
    name: basename(resolved.absolutePath),
    path: resolved.relativePath,
    isDirectory: metadata.isDirectory(),
    ref: resolved.ref,
    size: metadata.isFile() ? metadata.size : undefined,
    modifiedAt: metadata.mtime.toISOString(),
  };
}

export function readAuthorizedFileRef(ref: FileRef): FileRefReadResult {
  const resolved = resolveAuthorizedFileRef(ref);
  if (!statSync(resolved.absolutePath).isFile())
    throw new Error("FileRef 目标不是文件");
  return readFileRefDocument(
    resolved,
    ref.source === "project" || ref.source === "session",
  );
}

export function writeAuthorizedFileRef(
  input: WriteFileRefInput,
): WriteFileRefResult {
  if (input.ref.source !== "project" && input.ref.source !== "session") {
    throw new Error("该文件来源为只读");
  }
  const resolved = resolveAuthorizedFileRef(input.ref);
  const metadata = statSync(resolved.absolutePath);
  if (!metadata.isFile()) throw new Error("FileRef 目标不是文件");
  if (metadata.size > FILE_EDITABLE_LIMIT_BYTES)
    throw new Error("超过 10 MB 的文件不能编辑");
  if (Math.abs(metadata.mtimeMs - input.expectedMtimeMs) > 0.5) {
    return {
      outcome: "conflict",
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
    };
  }
  const document = readFileRefDocument(resolved, true);
  if (document.kind !== "text" || !document.editable)
    throw new Error("该文件编码不支持编辑");
  const normalized = normalizeLineEndings(input.content, document.lineEnding);
  const encoded = encodeTextDocument(
    normalized,
    document.encoding,
    document.bom,
  );
  if (encoded.byteLength > FILE_EDITABLE_LIMIT_BYTES) {
    throw new Error("保存内容超过 10 MB 编辑上限");
  }
  const temporaryPath = join(
    dirname(resolved.absolutePath),
    `.lume-${basename(resolved.absolutePath)}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, encoded, { mode: metadata.mode });
    const checked = resolveAuthorizedFileRef(input.ref);
    const current = statSync(checked.absolutePath);
    if (Math.abs(current.mtimeMs - input.expectedMtimeMs) > 0.5) {
      return {
        outcome: "conflict",
        mtimeMs: current.mtimeMs,
        size: current.size,
      };
    }
    renameSync(temporaryPath, checked.absolutePath);
    const saved = statSync(checked.absolutePath);
    markAuthorizedFileRefSelfWrite(input.ref, saved.mtimeMs, saved.size);
    return { outcome: "saved", mtimeMs: saved.mtimeMs, size: saved.size };
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

const FILE_EDITABLE_LIMIT_BYTES = 10 * 1024 * 1024;
const FILE_LOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export function readFileRefDocument(
  resolved: ResolvedAuthorizedFileRef,
  allowEditing: boolean,
): FileRefReadResult {
  const metadata = statSync(resolved.absolutePath);
  const mimeType = inferFileMimeType(resolved.absolutePath);
  if (metadata.size > FILE_LOAD_LIMIT_BYTES) {
    return {
      kind: "too-large",
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      mimeType,
      editable: false,
      truncated: true,
    };
  }
  const bytes = readFileSync(resolved.absolutePath);
  const decoded = decodeTextDocument(bytes);
  if (!decoded) {
    return {
      kind: "binary",
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      mimeType,
      editable: false,
      truncated: true,
    };
  }
  return {
    kind: "text",
    content: decoded.content,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    mimeType,
    encoding: decoded.encoding,
    bom: decoded.bom,
    lineEnding: detectLineEnding(decoded.content),
    editable: allowEditing && metadata.size <= FILE_EDITABLE_LIMIT_BYTES,
    truncated: false,
  };
}

function decodeTextDocument(bytes: Buffer): {
  content: string;
  encoding: "utf-8" | "utf-16le";
  bom: boolean;
} | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      content: bytes.subarray(2).toString("utf16le"),
      encoding: "utf-16le",
      bom: true,
    };
  }
  const hasUtf8Bom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  const contentBytes = hasUtf8Bom ? bytes.subarray(3) : bytes;
  if (contentBytes.subarray(0, Math.min(contentBytes.length, 8192)).includes(0))
    return null;
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(contentBytes),
      encoding: "utf-8",
      bom: hasUtf8Bom,
    };
  } catch {
    return null;
  }
}

function detectLineEnding(content: string): "lf" | "crlf" | "mixed" | "none" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf > 0) return "mixed";
  if (crlf > 0) return "crlf";
  if (lf > 0) return "lf";
  return "none";
}

function normalizeLineEndings(
  content: string,
  lineEnding: "lf" | "crlf" | "mixed" | "none",
): string {
  if (lineEnding === "lf") return content.replace(/\r\n/g, "\n");
  if (lineEnding === "crlf") return content.replace(/\r?\n/g, "\r\n");
  return content;
}

function encodeTextDocument(
  content: string,
  encoding: "utf-8" | "utf-16le",
  bom: boolean,
): Buffer {
  const body = Buffer.from(
    content,
    encoding === "utf-16le" ? "utf16le" : "utf8",
  );
  if (!bom) return body;
  return Buffer.concat([
    encoding === "utf-16le"
      ? Buffer.from([0xff, 0xfe])
      : Buffer.from([0xef, 0xbb, 0xbf]),
    body,
  ]);
}

function inferFileMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    (
      {
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".html": "text/html",
        ".htm": "text/html",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".pdf": "application/pdf",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".pdb": "chemical/x-pdb",
      } as Record<string, string>
    )[extension] ?? "text/plain"
  );
}

export function enrichEntryWithFileRef(
  entry: FileEntry,
  rootPath: string,
  source: FileRef["source"],
  scopeId: string,
): FileEntry {
  const relativePath = relative(rootPath, entry.path).split(sep).join("/");
  const ref: FileRef = { source, scopeId, relativePath };
  try {
    const metadata = lstatSync(entry.path);
    if (metadata.isSymbolicLink()) return { ...entry, isDirectory: false, ref };
    return {
      ...entry,
      ref,
      size: metadata.isFile() ? metadata.size : undefined,
      modifiedAt: metadata.mtime.toISOString(),
    };
  } catch {
    return { ...entry, ref };
  }
}

export type FileRefNotificationEmitter = (
  method: string,
  params: unknown,
) => void;
export interface FileWatchGroup {
  watcher: FSWatcher;
  ref: FileRef;
  absolutePath: string;
  subscriptions: Map<string, FileRefNotificationEmitter>;
}

export const fileWatchGroups = new Map<string, FileWatchGroup>();
export const fileWatchKeysById = new Map<string, string>();
export const selfWrites = new Map<
  string,
  { until: number; mtimeMs: number; size: number }
>();

export function authorizedFileRefWatchKey(ref: FileRef): string {
  const path = normalizeAuthorizedRelativePath(ref.relativePath);
  const normalized = process.platform === "win32" ? path.toLowerCase() : path;
  return `${ref.source}:${ref.scopeId}:${normalized}`;
}

export function markAuthorizedFileRefSelfWrite(
  ref: FileRef,
  mtimeMs: number,
  size: number,
): void {
  const key = authorizedFileRefWatchKey(ref);
  if (!fileWatchGroups.has(key)) return;
  selfWrites.set(key, { until: Date.now() + 1_000, mtimeMs, size });
}
