/**
 * office_thumbnail - 为 PPT 生成缩略图网格
 *
 * Tier: ondemand | Category: file | isReadOnly: true | isConcurrencySafe: true
 * 依赖: python3.11 + office-scripts/thumbnail.py
 *
 * 原始源码位置: runtime-Biw3JkjY.js -> em={name:"office_thumbnail",...}
 * 变量映射:
 *   o = path.isAbsolute
 *   r = path.join/resolve
 *   b = fs.existsSync
 *   Id = promisify(execFile) (spawnPromise)
 *   Md = thumbnail.py 路径
 *   Cd = office-scripts 目录
 */

import { z } from "zod";
import { resolve, isAbsolute } from "path";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const OFFICE_SCRIPTS_DIR = resolve(__dirname, "..", "office-scripts");
const THUMBNAIL_PY = resolve(OFFICE_SCRIPTS_DIR, "thumbnail.py");

interface ThumbnailResult {
  gridFiles: string[];
  message: string;
}

/** 调用 thumbnail.py 生成缩略图 */
async function generateThumbnails(
  pptxPath: string,
  outputPrefix?: string,
  cols?: number
): Promise<ThumbnailResult> {
  if (!existsSync(pptxPath)) throw new Error(`文件不存在：${pptxPath}`);

  const args = [THUMBNAIL_PY, pptxPath];
  if (outputPrefix) args.push(outputPrefix);
  if (cols != null) args.push("--cols", String(cols));

  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileAsync("python3.11", args, {
      cwd: OFFICE_SCRIPTS_DIR,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    const e = err.stderr?.trim?.() || "";
    const o = err.stdout?.trim?.() || "";
    throw new Error(`thumbnail.py 执行失败：${e || o || err.message || String(err)}`);
  }

  // 解析输出：找到 "Created ... grid(s):" 之后列出的文件
  const gridFiles: string[] = [];
  let inFilesSection = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Created ") && trimmed.includes("grid(s):")) {
      inFilesSection = true;
      continue;
    }
    if (inFilesSection && trimmed.length > 0) {
      gridFiles.push(trimmed);
    }
  }

  if (gridFiles.length === 0) {
    const errOutput = stderr?.trim() || stdout?.trim() || "未知错误";
    throw new Error(`缩略图生成失败，未找到输出文件：${errOutput}`);
  }

  return {
    gridFiles,
    message: `成功生成 ${gridFiles.length} 张缩略图网格`,
  };
}

export const officeThumbnailTool = {
  name: "office_thumbnail",
  description: "TOOL_OFFICE_THUMBNAIL_DESC",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  maxResultSizeChars: 5000,
  briefDescription: "TOOL_OFFICE_THUMBNAIL_BRIEF",

  inputSchema: z.object({
    pptx_path: z.string().describe("PPTX 文件路径"),
    output_prefix: z.string().optional().describe("输出文件前缀"),
    cols: z.number().optional().describe("每行列数"),
  }),

  async execute(
    { pptx_path, output_prefix, cols }: {
      pptx_path: string; output_prefix?: string; cols?: number;
    },
    context: { workdir: string }
  ) {
    try {
      const absPptxPath = isAbsolute(pptx_path) ? pptx_path : resolve(context.workdir, pptx_path);
      const result = await generateThumbnails(absPptxPath, output_prefix, cols);

      return {
        type: "success" as const,
        content: [
          "PPTX 缩略图网格生成完成",
          "",
          "| 项目 | 值 |",
          "|------|------|",
          `| 网格文件数 | ${result.gridFiles.length} |`,
          "",
          "生成的网格文件：",
          ...result.gridFiles.map(f => `- ${f}`),
        ].join("\n"),
      };
    } catch (err: any) {
      return { type: "error" as const, error: `缩略图生成失败：${err.message}` };
    }
  },
};
