import type { ToolDefinition } from "@lume/agent-sdk";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createSdkJsonResultTool } from "../sdk-tool-result";

type OfficeKind = "docx" | "pptx" | "xlsx" | "zip";

interface ZipEntrySummary {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

interface ZipPackEntry {
  name: string;
  data: Buffer;
  crc32: number;
}

export function createSdkOfficeTools(): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "office_validate",
      description: "只读校验 Office OOXML 包结构，列出 zip 条目并检查 docx/pptx/xlsx 关键 part 是否存在。不会解包或写入文件。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          maxEntries: { type: "number", minimum: 1, maximum: 200 }
        },
        required: ["path"]
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(args, context) {
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const maxEntries = clampMaxEntries(args.maxEntries);
        const buffer = readFileSync(path);
        const kind = detectOfficeKind(path);
        const zipEntries = parseZipEntries(buffer);
        const entryNames = zipEntries.map((entry) => entry.name);
        const requiredEntries = requiredEntriesForKind(kind);
        const missingRequiredEntries = requiredEntries.filter((entry) => !entryNames.includes(entry));

        return {
          ok: missingRequiredEntries.length === 0,
          path,
          kind,
          entryCount: zipEntries.length,
          entries: entryNames.slice(0, maxEntries),
          truncated: zipEntries.length > maxEntries,
          requiredEntries,
          missingRequiredEntries,
          warnings: buildWarnings(kind, zipEntries)
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_unpack",
      description: "安全解包 Office OOXML zip 包到指定目录。会跳过目录穿越条目，仅支持 store/deflate 条目。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          outputDir: { type: "string", minLength: 1 },
          maxEntries: { type: "number", minimum: 1, maximum: 1000 },
          maxTotalBytes: { type: "number", minimum: 1 }
        },
        required: ["path", "outputDir"]
      },
      async call(args, context) {
        const path = resolveInputPath(requiredString(args.path, "path"), context.cwd);
        const outputDir = resolveInputPath(requiredString(args.outputDir, "outputDir"), context.cwd);
        const maxEntries = clampNumber(args.maxEntries, 1000, 1, 1000);
        const maxTotalBytes = clampNumber(args.maxTotalBytes, 50 * 1024 * 1024, 1, 250 * 1024 * 1024);
        const buffer = readFileSync(path);
        const kind = detectOfficeKind(path);
        const allZipEntries = parseZipEntries(buffer);
        const zipEntries = allZipEntries.slice(0, maxEntries);
        const writtenFiles: string[] = [];
        const skippedUnsafeEntries: string[] = [];
        const skippedUnsupportedEntries: string[] = [];
        let totalUncompressedBytes = 0;

        mkdirSync(outputDir, { recursive: true });
        for (const entry of zipEntries) {
          if (entry.name.endsWith("/")) continue;
          const safeRelativePath = normalizeZipEntryPath(entry.name);
          if (!safeRelativePath) {
            skippedUnsafeEntries.push(entry.name);
            continue;
          }
          if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
            skippedUnsupportedEntries.push(entry.name);
            continue;
          }
          totalUncompressedBytes += entry.uncompressedSize;
          if (totalUncompressedBytes > maxTotalBytes) {
            throw new Error("office_unpack aborted: uncompressed size limit exceeded");
          }

          const data = readZipEntryData(buffer, entry);
          const outputPath = resolve(outputDir, safeRelativePath);
          if (!isPathInside(outputPath, outputDir)) {
            skippedUnsafeEntries.push(entry.name);
            continue;
          }
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, data);
          writtenFiles.push(safeRelativePath);
        }

        return {
          ok: skippedUnsupportedEntries.length === 0,
          path,
          outputDir,
          kind,
          entryCount: zipEntries.length,
          writtenCount: writtenFiles.length,
          writtenFiles,
          skippedUnsafeEntries,
          skippedUnsupportedEntries,
          truncated: allZipEntries.length > maxEntries
        };
      }
    }),
    createSdkJsonResultTool({
      name: "office_pack",
      description: "将解包后的 Office OOXML 目录重新打包为 docx/pptx/xlsx/zip。输出路径必须在输入目录外。",
      inputSchema: {
        type: "object",
        properties: {
          inputDir: { type: "string", minLength: 1 },
          outputPath: { type: "string", minLength: 1 },
          maxEntries: { type: "number", minimum: 1, maximum: 1000 },
          maxTotalBytes: { type: "number", minimum: 1 }
        },
        required: ["inputDir", "outputPath"]
      },
      async call(args, context) {
        const inputDir = resolveInputPath(requiredString(args.inputDir, "inputDir"), context.cwd);
        const outputPath = resolveInputPath(requiredString(args.outputPath, "outputPath"), context.cwd);
        if (isPathInside(outputPath, inputDir)) {
          throw new Error("office_pack outputPath must be outside inputDir");
        }
        if (!statSync(inputDir).isDirectory()) {
          throw new Error("office_pack inputDir must be a directory");
        }

        const maxEntries = clampNumber(args.maxEntries, 1000, 1, 1000);
        const maxTotalBytes = clampNumber(args.maxTotalBytes, 50 * 1024 * 1024, 1, 250 * 1024 * 1024);
        const entries = collectZipPackEntries(inputDir, maxEntries, maxTotalBytes);
        if (entries.length === 0) {
          throw new Error("office_pack inputDir contains no files");
        }

        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, buildZipArchive(entries));

        return {
          ok: true,
          inputDir,
          outputPath,
          kind: detectOfficeKind(outputPath),
          entryCount: entries.length,
          entries: entries.map((entry) => entry.name)
        };
      }
    })
  ];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function resolveInputPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function clampMaxEntries(value: unknown): number {
  return clampNumber(value, 40, 1, 200);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function detectOfficeKind(path: string): OfficeKind {
  const ext = extname(path).toLowerCase();
  if (ext === ".docx") return "docx";
  if (ext === ".pptx") return "pptx";
  if (ext === ".xlsx") return "xlsx";
  return "zip";
}

function requiredEntriesForKind(kind: OfficeKind): string[] {
  const shared = ["[Content_Types].xml", "_rels/.rels"];
  if (kind === "docx") return [...shared, "word/document.xml"];
  if (kind === "pptx") return [...shared, "ppt/presentation.xml"];
  if (kind === "xlsx") return [...shared, "xl/workbook.xml"];
  return shared;
}

function buildWarnings(kind: OfficeKind, entries: ZipEntrySummary[]): string[] {
  const warnings: string[] = [];
  if (kind === "zip") {
    warnings.push("文件扩展名不是 docx/pptx/xlsx，仅按通用 zip 包结构检查。");
  }
  if (entries.some((entry) => entry.compressionMethod !== 0 && entry.compressionMethod !== 8)) {
    warnings.push("发现非 store/deflate 压缩方式的条目，当前工具只列目录不解压内容。");
  }
  return warnings;
}

function collectZipPackEntries(inputDir: string, maxEntries: number, maxTotalBytes: number): ZipPackEntry[] {
  const filePaths: string[] = [];
  let totalBytes = 0;

  function walk(dir: string): void {
    const dirents = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
      const filePath = resolve(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(filePath);
        continue;
      }
      if (!dirent.isFile()) continue;

      const stats = statSync(filePath);
      totalBytes += stats.size;
      if (filePaths.length >= maxEntries) {
        throw new Error("office_pack aborted: entry count limit exceeded");
      }
      if (totalBytes > maxTotalBytes) {
        throw new Error("office_pack aborted: total size limit exceeded");
      }
      filePaths.push(filePath);
    }
  }

  walk(inputDir);
  return filePaths
    .map((filePath) => {
      const name = toZipEntryName(inputDir, filePath);
      const data = readFileSync(filePath);
      return { name, data, crc32: crc32(data) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function toZipEntryName(inputDir: string, filePath: string): string {
  const relativePath = relative(inputDir, filePath).split(sep).join("/");
  const safePath = normalizeZipEntryPath(relativePath);
  if (!safePath) {
    throw new Error(`office_pack found unsafe file path: ${relativePath}`);
  }
  return safePath;
}

function buildZipArchive(entries: ZipPackEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(entry.crc32, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    localParts.push(local, entry.data);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(entry.crc32, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);

    offset += local.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC32_TABLE[index] = value >>> 0;
}

function parseZipEntries(buffer: Buffer): ZipEntrySummary[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error("Not a valid zip file: end of central directory not found");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryOffset < 0 || centralDirectoryEnd > buffer.length) {
    throw new Error("Invalid zip file: central directory is outside the file");
  }

  const entries: ZipEntrySummary[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralDirectoryEnd || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid zip file: malformed central directory entry");
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > centralDirectoryEnd) {
      throw new Error("Invalid zip file: malformed file name");
    }

    entries.push({
      name: buffer.toString("utf-8", fileNameStart, fileNameEnd),
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset: buffer.readUInt32LE(offset + 42)
    });
    offset = fileNameEnd + extraLength + commentLength;
  }

  return entries;
}

function readZipEntryData(buffer: Buffer, entry: ZipEntrySummary): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Invalid zip file: malformed local header for ${entry.name}`);
  }
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new Error(`Invalid zip file: compressed data outside file for ${entry.name}`);
  }

  const data = buffer.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) return Buffer.from(data);
  return inflateRawSync(data);
}

function normalizeZipEntryPath(name: string): string | null {
  const normalized = normalize(name.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("..") || isAbsolute(normalized)) return null;
  return normalized.split(sep).join("/");
}

function isPathInside(path: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}
