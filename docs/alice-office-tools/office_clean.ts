/**
 * office_clean - 清理 Office 文档中的孤立资源
 *
 * Tier: ondemand | Category: file | isDestructive: true (唯一标记为破坏性的工具)
 * 依赖: python3.11 + office-scripts/clean.py
 *
 * 原始源码位置: runtime-Biw3JkjY.js -> jd={name:"office_clean",...}
 * 变量映射:
 *   pd = promisify(execFile)  (用于 clean.py)
 *   hd = clean.py 路径
 *   md = office-scripts 目录
 *   _d = parseCleanOutput()  解析 "Removed" 输出段
 *   gd = detectFormat()  检测文档格式
 */

import { z } from "zod";
import { resolve, isAbsolute, extname, basename, readdirSync } from "path";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const OFFICE_SCRIPTS_DIR = resolve(__dirname, "..", "office-scripts");
const CLEAN_PY = resolve(OFFICE_SCRIPTS_DIR, "clean.py");

/** 从 clean.py 的 stdout 中解析被删除的文件列表 */
function parseCleanOutput(stdout: string): string[] {
  const removedIdx = stdout.indexOf("Removed");
  if (removedIdx === -1) return [];

  const lines = stdout.slice(removedIdx).split("\n").slice(1);
  const files: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) files.push(trimmed);
  }
  return files;
}

/** 检测文档格式 */
function detectFormat(dirPath: string): string {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === "word") return "docx";
        if (entry.name === "ppt") return "pptx";
        if (entry.name === "xl") return "xlsx";
      }
    }
  } catch {}
  return "unknown";
}

export const officeCleanTool = {
  name: "office_clean",
  description: "TOOL_OFFICE_CLEAN_DESC",
  briefDescription: "TOOL_OFFICE_CLEAN_BRIEF",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: true,       // ⚠️ 唯一标记为破坏性的工具
  isConcurrencySafe: false,
  maxResultSizeChars: 10000,

  inputSchema: z.object({
    dir_path: z.string().describe("已解压的 Office 文档目录路径"),
  }),

  async execute(
    { dir_path }: { dir_path: string },
    context: { workdir: string }
  ) {
    try {
      const absDirPath = isAbsolute(dir_path) ? dir_path : resolve(context.workdir, dir_path);

      // ── 调用 clean.py ──
      let stdout: string;
      try {
        const result = await execFileAsync("python3.11", [CLEAN_PY, absDirPath], {
          cwd: OFFICE_SCRIPTS_DIR,
          timeout: 60000,
          maxBuffer: 10 * 1024 * 1024,
        });
        stdout = result.stdout;
      } catch (err: any) {
        const stderr = err.stderr?.trim?.() || "";
        const out = err.stdout?.trim?.() || "";
        throw new Error(`clean.py 执行失败：${stderr || out || err.message || String(err)}`);
      }

      const removedFiles = parseCleanOutput(stdout);
      const format = detectFormat(absDirPath);

      // ── 无孤立资源 ──
      if (removedFiles.length === 0) {
        return {
          type: "success" as const,
          content: `清理完成，未发现孤立资源（格式：${format}）。`,
        };
      }

      // ── 有孤立资源被删除 ──
      const lines = [
        `清理完成（格式：${format}）`,
        "",
        `共删除 ${removedFiles.length} 个孤立文件：`,
        "",
      ];
      for (const f of removedFiles.slice(0, 50)) lines.push(`- ${f}`);
      if (removedFiles.length > 50) lines.push(`- …还有 ${removedFiles.length - 50} 个文件`);

      return { type: "success" as const, content: lines.join("\n") };
    } catch (err: any) {
      return { type: "error" as const, error: `清理失败：${err.message}` };
    }
  },
};
