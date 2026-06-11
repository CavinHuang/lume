/**
 * office_unpack - 将 Office 文档解压为 XML 目录结构
 *
 * Tier: core | Category: file
 * 依赖: python3.11 + office-scripts/office/unpack.py
 */

import { z } from "zod";
import { resolve, isAbsolute, extname } from "path";
import { readdir, stat, readFile } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// office-scripts 路径
const OFFICE_SCRIPTS_DIR = resolve(__dirname, "..", "office-scripts");
const OFFICE_DIR = resolve(OFFICE_SCRIPTS_DIR, "office");
const UNPACK_PY = resolve(OFFICE_DIR, "unpack.py");

export const officeUnpackTool = {
  name: "office_unpack",
  description: "TOOL_OFFICE_UNPACK_DESC",
  systemHint: "TOOL_OFFICE_UNPACK_HINT",
  category: "file" as const,
  tier: "core" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 10000,

  inputSchema: z.object({
    file_path: z.string().describe("要解压的 Office 文件路径（.docx/.pptx/.xlsx）"),
    output_dir: z.string().optional().describe("输出目录路径（可选，默认自动生成）"),
  }),

  async execute(
    { file_path, output_dir }: { file_path: string; output_dir?: string },
    context: { workdir: string }
  ) {
    try {
      const absFilePath = isAbsolute(file_path) ? file_path : resolve(context.workdir, file_path);
      const absOutputDir = output_dir
        ? (isAbsolute(output_dir) ? output_dir : resolve(context.workdir, output_dir))
        : undefined;

      const result = await unpackOfficeDocument(absFilePath, absOutputDir);

      return {
        type: "success" as const,
        content: [
          "Office 文档解压完成",
          "",
          "| 项目 | 值 |",
          "|------|------|",
          `| 输出目录 | ${result.outputDir} |`,
          `| 文档格式 | ${result.format} |`,
          `| 总文件数 | ${result.totalFiles} |`,
          `| XML 文件 | ${result.xmlFiles} |`,
          `| 媒体文件 | ${result.mediaFiles} |`,
          "",
          "你现在可以用 read_file / write_file 编辑目录中的 XML 文件，",
          "编辑完成后使用 office_pack 重新打包为 Office 文档。",
        ].join("\n"),
      };
    } catch (err: any) {
      return { type: "error" as const, error: `解压失败：${err.message}` };
    }
  },
};

// ============================================================
// 核心实现
// ============================================================
const XML_EXTENSIONS = new Set([".xml", ".rels"]);
const MEDIA_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".emf", ".wmf", ".tiff", ".tif", ".mp4", ".avi", ".wmv"]);

interface UnpackResult {
  outputDir: string;
  format: string;
  totalFiles: number;
  xmlFiles: number;
  mediaFiles: number;
}

/** 检测文档格式 */
function detectFormat(dirPath: string): string {
  try {
    const entries = readdir(dirPath, { withFileTypes: true });
    // 同步检查不需要 await，但上面的 readdir 是 async
    // 格式检测基于文件名模式
  } catch {}
  try {
    if (existsSync(resolve(dirPath, "word"))) return "docx";
    if (existsSync(resolve(dirPath, "ppt"))) return "pptx";
    if (existsSync(resolve(dirPath, "xl"))) return "xlsx";
  } catch {}
  return "unknown";
}

/** 统计目录中的文件 */
async function countFiles(dirPath: string): Promise<{ total: number; xml: number; media: number }> {
  let total = 0, xml = 0, media = 0;
  const ext = (name: string) => {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot).toLowerCase() : "";
  };

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      total++;
      const e = ext(entry.name);
      if (XML_EXTENSIONS.has(e)) xml++;
      else if (MEDIA_EXTENSIONS.has(e)) media++;
    }
  }

  await walk(dirPath);
  return { total, xml, media };
}

/** 解压 Office 文档 */
async function unpackOfficeDocument(filePath: string, outputDir?: string): Promise<UnpackResult> {
  if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`);

  // 调用 Python unpack.py 脚本
  const args = [UNPACK_PY, filePath];
  if (outputDir) args.push(outputDir);

  let stdout: string;
  try {
    const result = await execFileAsync("python3.11", args, {
      cwd: OFFICE_DIR,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: any) {
    throw new Error(`unpack.py 执行失败：${err.stderr?.trim?.() || err.message}`);
  }

  // 解析输出目录（从 stdout 或根据输入路径推导）
  const actualOutputDir = outputDir || filePath.replace(/\.\w+$/, "_unpacked");
  const format = detectFormat(actualOutputDir);
  const counts = await countFiles(actualOutputDir);

  return {
    outputDir: actualOutputDir,
    format,
    totalFiles: counts.total,
    xmlFiles: counts.xml,
    mediaFiles: counts.media,
  };
}
