/**
 * 受控 Markdown 文件 facade（移植自 Proma vault-service 的 createVaultFileSystem）：
 * 所有 Obsidian Vault 磁盘读写收敛于此。安全语义：仅 .md、拒绝绝对路径/
 * `..`/空段/隐藏目录/软链接、根内越界检查、mkdir 后复验（TOCTOU）、
 * 2MB/5000 文件/深度 16 限额、sha256 乐观锁、独占创建、原子写。
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ObsidianVaultDeleteInput,
  ObsidianVaultFileEntry,
  ObsidianVaultReadResult,
  ObsidianVaultRenameInput,
  ObsidianVaultSavePastedImageInput,
  ObsidianVaultSavePastedImageResult,
  ObsidianVaultWriteInput,
  ObsidianVaultWriteResult,
} from "@lume/shared";
import { writeFileAtomic } from "@lume/agent-sdk";
import { assertVaultRoot } from "./vault-registry";
import { isValidImageBytes } from "./image-content-validation";

const MAX_VAULT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_VAULT_FILES = 5_000;
const MAX_VAULT_DEPTH = 16;
const HIDDEN_DIRECTORY_PREFIX = ".";
const MAX_VAULT_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;
// 解码前先拒超限 base64，避免多复制一份 Node Buffer。
const MAX_VAULT_PASTED_IMAGE_BASE64_CHARS = Math.ceil(MAX_VAULT_PASTED_IMAGE_BYTES / 3) * 4;
const PASTED_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizeRelativeMarkdownPath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error("Vault 相对路径不能为空");
  }
  if (isAbsolute(value) || isWindowsAbsolutePath(value)) {
    throw new Error("Vault 不接受绝对路径");
  }
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(HIDDEN_DIRECTORY_PREFIX))) {
    throw new Error("Vault 路径不能包含隐藏目录、空段或上级目录");
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("Vault 仅支持 Markdown (.md) 文件");
  }
  return parts.join("/");
}

function normalizeRelativeVaultFolderPath(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Vault 文件夹路径非法");
  }
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized) return "";
  if (isAbsolute(normalized) || isWindowsAbsolutePath(normalized)) {
    throw new Error("Vault 不接受绝对路径");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(HIDDEN_DIRECTORY_PREFIX))) {
    throw new Error("Vault 文件夹路径不能包含隐藏目录、空段或上级目录");
  }
  return parts.join("/");
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const fromRoot = relative(rootPath, targetPath);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function getSafeVaultPath(rootPath: string, relativePath: string): { absolutePath: string; relativePath: string } {
  const absolutePath = resolve(rootPath, relativePath);
  if (!isWithinRoot(rootPath, absolutePath)) {
    throw new Error("Vault 路径超出授权根目录");
  }
  let current = rootPath;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Vault 不允许通过软链接访问文件");
    }
  }
  return { absolutePath, relativePath };
}

function getSafeVaultTarget(rootPath: string, relativePath: string): { absolutePath: string; relativePath: string } {
  return getSafeVaultPath(rootPath, normalizeRelativeMarkdownPath(relativePath));
}

function getSafeVaultFolderTarget(rootPath: string, relativePath: string): { absolutePath: string; relativePath: string } {
  return getSafeVaultPath(rootPath, normalizeRelativeVaultFolderPath(relativePath));
}

function toRelativePath(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(/[/\\]/).join("/");
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function untitledNoteFilename(date: Date, sequence: number): string {
  const suffix = sequence === 1 ? "" : ` ${sequence}`;
  return `Untitled ${formatLocalDate(date)}${suffix}.md`;
}

function createFileExclusively(filePath: string, content: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, "wx");
    writeFileSync(descriptor, content, "utf-8");
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return false;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertContentSize(content: string): void {
  if (Buffer.byteLength(content, "utf-8") > MAX_VAULT_FILE_BYTES) {
    throw new Error("Vault 写入内容超过 2 MB 限制");
  }
}

export interface ObsidianVaultFileSystem {
  listFiles(): ObsidianVaultFileEntry[];
  readFile(relativePath: string): ObsidianVaultReadResult;
  resolveMedia(noteRelativePath: string, src: string): string | null;
  savePastedImage(input: Omit<ObsidianVaultSavePastedImageInput, "vaultPath">): ObsidianVaultSavePastedImageResult;
  writeFile(input: Omit<ObsidianVaultWriteInput, "vaultPath">): Promise<ObsidianVaultWriteResult>;
  createUntitledNote(folderPath?: string, content?: string, now?: Date): Promise<ObsidianVaultWriteResult>;
  createFolder(relativePath: string): void;
  renameFile(input: Omit<ObsidianVaultRenameInput, "vaultPath">): ObsidianVaultReadResult;
  deleteFile(input: Omit<ObsidianVaultDeleteInput, "vaultPath">): void;
}

/** 校验 focus 目标存在且类型匹配，返回规范化后的相对路径。 */
export function resolveSafeVaultEntry(rootPath: string, kind: "file" | "folder", relativePath: string): string {
  const root = assertVaultRoot(rootPath);
  const target = kind === "file"
    ? getSafeVaultTarget(root, relativePath)
    : getSafeVaultFolderTarget(root, relativePath);
  if (!existsSync(target.absolutePath)) throw new Error("Vault focus 目标不存在");
  const stats = lstatSync(target.absolutePath);
  if (kind === "file" ? !stats.isFile() : !stats.isDirectory()) {
    throw new Error(`Vault focus 目标不是${kind === "file" ? " Markdown 文件" : "文件夹"}`);
  }
  return target.relativePath;
}

/** 为一个已授权的 Vault 根创建有界文件系统 facade。 */
export function createVaultFileSystem(rootPath: string): ObsidianVaultFileSystem {
  const root = assertVaultRoot(rootPath);

  const listFiles = (): ObsidianVaultFileEntry[] => {
    const entries: ObsidianVaultFileEntry[] = [];
    const walk = (currentDir: string, depth: number): void => {
      if (depth > MAX_VAULT_DEPTH || entries.length >= MAX_VAULT_FILES) return;
      let dirEntries: import("node:fs").Dirent[];
      try {
        dirEntries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of dirEntries) {
        if (entries.length >= MAX_VAULT_FILES || entry.name.startsWith(HIDDEN_DIRECTORY_PREFIX) || entry.isSymbolicLink()) continue;
        const absolutePath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(absolutePath, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
        try {
          const stats = statSync(absolutePath);
          entries.push({
            relativePath: toRelativePath(root, absolutePath),
            name: entry.name,
            size: stats.size,
            modifiedAt: stats.mtimeMs,
          });
        } catch {
          // 遍历期间文件可能消失或暂时不可访问，跳过后继续处理其他条目。
        }
      }
    };
    walk(root, 0);
    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  };

  const readFile = (relativePath: string): ObsidianVaultReadResult => {
    const target = getSafeVaultTarget(root, relativePath);
    if (!existsSync(target.absolutePath)) throw new Error(`Vault 文件不存在: ${target.relativePath}`);
    const stats = lstatSync(target.absolutePath);
    if (!stats.isFile()) throw new Error("Vault 目标不是普通文件");
    if (stats.size > MAX_VAULT_FILE_BYTES) throw new Error("Vault 文件超过 2 MB 读取上限");
    const content = readFileSync(target.absolutePath, "utf-8");
    return {
      relativePath: target.relativePath,
      content,
      sha256: sha256(content),
      modifiedAt: stats.mtimeMs,
    };
  };

  // 媒体解析面向 .obsidian 之外的所有根内文件，不走仅 .md 的 getSafeVaultTarget。
  const resolveMedia = (noteRelativePath: string, src: string): string | null => {
    if (typeof src !== "string" || !src.trim() || src.includes("\0")) return null;
    const note = getSafeVaultTarget(root, noteRelativePath);
    const source = src.trim().replace(/[?#].*$/, "");
    if (!source) return null;

    let candidate: string;
    try {
      // file: 经 fileURLToPath 归一化（处理 Windows 盘符），裸 pathname 的
      // /D:/... 形态在 win32 relative 下恒判越界（Proma 同款缺陷，此处修复）。
      candidate = source.toLowerCase().startsWith("file:")
        ? resolve(fileURLToPath(new URL(source)))
        : resolve(dirname(note.absolutePath), decodeURIComponent(source));
    } catch {
      return null;
    }
    if (!isWithinRoot(root, candidate)) return null;

    const relativeCandidate = toRelativePath(root, candidate);
    try {
      const target = getSafeVaultPath(root, relativeCandidate);
      return existsSync(target.absolutePath) && lstatSync(target.absolutePath).isFile() ? target.absolutePath : null;
    } catch {
      return null;
    }
  };

  const savePastedImage = (input: Omit<ObsidianVaultSavePastedImageInput, "vaultPath">): ObsidianVaultSavePastedImageResult => {
    const extension = PASTED_IMAGE_EXTENSIONS[input.mimeType];
    if (!extension || typeof input.base64 !== "string" || input.base64.length === 0 || input.base64.length > MAX_VAULT_PASTED_IMAGE_BASE64_CHARS) return { src: null };
    const normalizedBase64 = input.base64.replace(/\s/g, "");
    if (!normalizedBase64 || normalizedBase64.length > MAX_VAULT_PASTED_IMAGE_BASE64_CHARS || normalizedBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64)) return { src: null };

    const data = Buffer.from(normalizedBase64, "base64");
    // 声明 MIME 必须命中完整图片结构签名，拒绝改后缀/多态文件（Proma 同校验）。
    if (!isValidImageBytes(input.mimeType, data) || data.length > MAX_VAULT_PASTED_IMAGE_BYTES) return { src: null };

    const note = getSafeVaultTarget(root, input.noteRelativePath);
    const directory = dirname(note.relativePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `pasted-image-${timestamp}-${randomUUID()}.${extension}`;
    const mediaRelativePath = directory === "." ? `assets/${filename}` : `${directory}/assets/${filename}`;
    const target = getSafeVaultPath(root, mediaRelativePath);
    mkdirSync(dirname(target.absolutePath), { recursive: true });
    // mkdir 引入新祖先，写前按当前目录树复验一次。
    const revalidated = getSafeVaultPath(root, mediaRelativePath);
    writeFileSync(revalidated.absolutePath, data, { flag: "wx" });
    return { src: toRelativePath(dirname(note.absolutePath), revalidated.absolutePath) };
  };

  const writeFile = async (input: Omit<ObsidianVaultWriteInput, "vaultPath">): Promise<ObsidianVaultWriteResult> => {
    assertContentSize(input.content);
    const target = getSafeVaultTarget(root, input.relativePath);
    const exists = existsSync(target.absolutePath);
    if (exists) {
      const current = readFile(target.relativePath);
      if (input.expectedSha256 && input.expectedSha256 !== current.sha256) {
        return { ok: false, reason: "conflict", currentSha256: current.sha256, currentModifiedAt: current.modifiedAt };
      }
    } else if (input.expectedSha256) {
      throw new Error("Vault 文件已不存在，无法按预期版本写入");
    }

    mkdirSync(dirname(target.absolutePath), { recursive: true });
    // mkdir 引入新祖先，写前按当前目录树复验一次。
    const revalidated = getSafeVaultTarget(root, target.relativePath);
    await writeFileAtomic(revalidated.absolutePath, input.content, (resolved) =>
      isWithinRoot(root, resolved) ? null : "Vault 原子写入目标越出授权根目录",
    );
    const result = readFile(revalidated.relativePath);
    return { ok: true, relativePath: result.relativePath, sha256: result.sha256, modifiedAt: result.modifiedAt };
  };

  const createUntitledNote = async (folderPath = "", content = "", now = new Date()): Promise<ObsidianVaultWriteResult> => {
    assertContentSize(content);
    const folder = getSafeVaultFolderTarget(root, folderPath);
    // Proma 语义：仅顶层收件夹随创建自动补齐；更深层路径要求目标文件夹
    // 已存在，拼错/已被外部删除的路径报错而不是凭空建出目录树。
    if (folder.relativePath.includes("/")) {
      const stats = existsSync(folder.absolutePath) ? lstatSync(folder.absolutePath) : null;
      if (!stats || !stats.isDirectory()) throw new Error("目标 Vault 文件夹不存在");
    }

    for (let sequence = 1; sequence <= Number.MAX_SAFE_INTEGER; sequence++) {
      const relativePath = folder.relativePath
        ? `${folder.relativePath}/${untitledNoteFilename(now, sequence)}`
        : untitledNoteFilename(now, sequence);
      const target = getSafeVaultTarget(root, relativePath);
      if (!folder.relativePath.includes("/")) {
        mkdirSync(dirname(target.absolutePath), { recursive: true });
      }
      const revalidated = getSafeVaultTarget(root, target.relativePath);
      if (!createFileExclusively(revalidated.absolutePath, content)) continue;
      const result = readFile(revalidated.relativePath);
      return { ok: true, relativePath: result.relativePath, sha256: result.sha256, modifiedAt: result.modifiedAt };
    }
    throw new Error("Vault 无法分配未命名笔记文件名");
  };

  const createFolder = (relativePath: string): void => {
    const target = getSafeVaultFolderTarget(root, relativePath);
    if (!target.relativePath) throw new Error("不能创建 Vault 根文件夹");
    if (existsSync(target.absolutePath)) throw new Error("同名文件或文件夹已存在");
    const parent = dirname(target.absolutePath);
    if (!existsSync(parent) || !lstatSync(parent).isDirectory()) {
      throw new Error("目标 Vault 父文件夹不存在");
    }
    const revalidated = getSafeVaultFolderTarget(root, target.relativePath);
    mkdirSync(revalidated.absolutePath);
  };

  const renameFile = (input: Omit<ObsidianVaultRenameInput, "vaultPath">): ObsidianVaultReadResult => {
    const source = getSafeVaultTarget(root, input.relativePath);
    const current = readFile(source.relativePath);
    if (input.expectedSha256 && input.expectedSha256 !== current.sha256) {
      throw new Error("文件已在外部修改，请刷新后再重命名");
    }

    const requestedName = input.name.trim();
    if (!requestedName || requestedName.includes("/") || requestedName.includes("\\") || requestedName.includes("\0")) {
      throw new Error("文件名不能为空且不能包含路径分隔符");
    }
    const filename = requestedName.toLowerCase().endsWith(".md") ? requestedName : `${requestedName}.md`;
    const parentPath = source.relativePath.includes("/") ? source.relativePath.slice(0, source.relativePath.lastIndexOf("/")) : "";
    const target = getSafeVaultTarget(root, parentPath ? `${parentPath}/${filename}` : filename);
    if (target.relativePath === source.relativePath) return current;
    if (existsSync(target.absolutePath)) throw new Error("同名 Markdown 文件已存在");

    mkdirSync(dirname(target.absolutePath), { recursive: true });
    const revalidatedTarget = getSafeVaultTarget(root, target.relativePath);
    renameSync(source.absolutePath, revalidatedTarget.absolutePath);
    return readFile(revalidatedTarget.relativePath);
  };

  const deleteFile = (input: Omit<ObsidianVaultDeleteInput, "vaultPath">): void => {
    const target = getSafeVaultTarget(root, input.relativePath);
    if (!existsSync(target.absolutePath)) throw new Error(`Vault 文件不存在: ${target.relativePath}`);
    const stats = lstatSync(target.absolutePath);
    if (!stats.isFile()) throw new Error("Vault 目标不是普通文件");
    if (input.expectedSha256) {
      if (stats.size > MAX_VAULT_FILE_BYTES) throw new Error("Vault 文件超过 2 MB 校验上限");
      const current = readFile(target.relativePath);
      if (input.expectedSha256 !== current.sha256) {
        throw new Error("文件已在外部修改，请刷新后再删除");
      }
    }

    // unlink 前复验，防止竞态引入的软链接祖先。
    const revalidated = getSafeVaultTarget(root, target.relativePath);
    if (!lstatSync(revalidated.absolutePath).isFile()) throw new Error("Vault 目标不是普通文件");
    unlinkSync(revalidated.absolutePath);
  };

  return { listFiles, readFile, resolveMedia, savePastedImage, writeFile, createUntitledNote, createFolder, renameFile, deleteFile };
}
