/**
 * office_convert - Office 文档格式转换（依赖 LibreOffice headless）
 *
 * Tier: ondemand | Category: file | isConcurrencySafe: true
 * 依赖: LibreOffice (soffice) headless 模式
 * 支持格式: pdf, docx, xlsx, pptx, html, png, jpg
 *
 * 原始源码位置: runtime-Biw3JkjY.js -> Bd={name:"office_convert",...}
 * 变量映射:
 *   Ud = promisify(execFile) wrapper (spawnPromise(ie))
 *   o = path.isAbsolute, r = path.resolve/join
 *   n = path.dirname, s = path.basename, u = path.splitext去掉扩展名
 *   b = fs.existsSync, On = fs.readdir
 */

import { z } from "zod";
import { resolve, isAbsolute, dirname, basename, extname, join } from "path";
import { existsSync, readdirSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** 去掉文件扩展名 */
function stripExt(filePath: string): string {
  const ext = extname(filePath);
  return basename(filePath, ext);
}

/** 查找 LibreOffice 可执行文件 */
async function findLibreOffice(): Promise<string | null> {
  // macOS 和 Linux 常见路径
  const knownPaths = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",  // macOS
    "/usr/bin/soffice",                                        // Linux (apt)
    "/usr/local/bin/soffice",                                  // Linux (manual)
    "/snap/bin/libreoffice",                                   // Linux (snap)
  ];

  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }

  // 尝试 which 命令
  try {
    const { stdout } = await execFileAsync("which", ["soffice"]);
    const trimmed = stdout.trim();
    if (trimmed) return trimmed;
  } catch {}

  return null;
}

export const officeConvertTool = {
  name: "office_convert",
  description: "TOOL_OFFICE_CONVERT_DESC",
  briefDescription: "TOOL_OFFICE_CONVERT_BRIEF",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  maxResultSizeChars: 5000,

  inputSchema: z.object({
    file_path: z.string().describe("源文件路径"),
    target_format: z.enum(["pdf", "docx", "xlsx", "pptx", "html", "png", "jpg"])
      .describe("目标格式"),
  }),

  async execute(
    { file_path, target_format }: { file_path: string; target_format: string },
    context: { workdir: string }
  ) {
    try {
      // ── 1. 查找 LibreOffice ──
      const soffice = await findLibreOffice();
      if (!soffice) {
        return {
          type: "error" as const,
          error: [
            "未找到 LibreOffice。请先安装：",
            "- macOS: brew install --cask libreoffice",
            "- Ubuntu: sudo apt install libreoffice",
            "- Windows: 从 https://www.libreoffice.org 下载安装",
          ].join("\n"),
        };
      }

      // ── 2. 解析路径 ──
      const absFilePath = isAbsolute(file_path) ? file_path : resolve(context.workdir, file_path);
      if (!existsSync(absFilePath)) {
        return { type: "error" as const, error: `文件不存在：${absFilePath}` };
      }

      const outputDir = dirname(absFilePath);

      // ── 3. 执行 LibreOffice headless 转换 ──
      const args = ["--headless", "--convert-to", target_format, "--outdir", outputDir, absFilePath];
      const { stdout, stderr } = await execFileAsync(soffice, args, { timeout: 120000 });

      // ── 4. 检查输出文件 ──
      const baseName = stripExt(absFilePath);
      const expectedOutput = join(outputDir, `${baseName}.${target_format}`);

      if (existsSync(expectedOutput)) {
        return {
          type: "success" as const,
          content: [
            "格式转换完成",
            "",
            "| 项目 | 值 |",
            "|------|------|",
            `| 源文件 | ${absFilePath} |`,
            `| 输出文件 | ${expectedOutput} |`,
            `| 目标格式 | ${target_format} |`,
          ].join("\n"),
        };
      }

      // 图片格式可能生成多个文件（每页一张）
      if (target_format === "png" || target_format === "jpg") {
        const files = readdirSync(outputDir)
          .filter(f => f.startsWith(baseName) && f.endsWith(`.${target_format}`));
        if (files.length > 0) {
          return {
            type: "success" as const,
            content: [
              `格式转换完成，共生成 ${files.length} 个文件：`,
              "",
              ...files.map(f => `- ${join(outputDir, f)}`),
            ].join("\n"),
          };
        }
      }

      return {
        type: "error" as const,
        error: `转换命令已执行但未找到输出文件。\nstdout: ${stdout}\nstderr: ${stderr}`,
      };
    } catch (err: any) {
      return { type: "error" as const, error: `格式转换失败：${err.message}` };
    }
  },
};
