/**
 * 受控 Markdown 文件 facade（移植自 Proma vault-service 的 createVaultFileSystem）：
 * 所有 Obsidian Vault 磁盘读写收敛于此。安全语义：仅 .md、拒绝绝对路径/
 * `..`/空段/隐藏目录/软链接、根内越界检查、mkdir 后复验（TOCTOU）、
 * 2MB/5000 文件/深度 16 限额、sha256 乐观锁、独占创建、原子写。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ObsidianVaultDeleteInput,
  ObsidianVaultFileEntry,
  ObsidianVaultReadResult,
  ObsidianVaultRenameInput,
  ObsidianVaultWriteInput,
  ObsidianVaultWriteResult,
} from "@lume/shared";
import { writeFileAtomic } from "@lume/agent-sdk";
import { assertVaultRoot } from "./vault-registry";

const MAX_VAULT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_VAULT_FILES = 5_000;
const MAX_VAULT_DEPTH = 16;
const HIDDEN_DIRECTORY_PREFIX = ".";

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

    for (let sequence = 1; sequence <= Number.MAX_SAFE_INTEGER; sequence++) {
      const relativePath = folder.relativePath
        ? `${folder.relativePath}/${untitledNoteFilename(now, sequence)}`
        : untitledNoteFilename(now, sequence);
      const target = getSafeVaultTarget(root, relativePath);
      // 收件夹等父目录随创建自动补齐（Proma 的 inbox 语义）。
      mkdirSync(dirname(target.absolutePath), { recursive: true });
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

  return { listFiles, readFile, writeFile, createUntitledNote, createFolder, renameFile, deleteFile };
}
