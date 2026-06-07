import type { ToolDefinition } from "@lume/agent-sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, normalize, resolve, sep } from "node:path";
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
