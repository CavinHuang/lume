/**
 * xlsx_create - 使用 Python (openpyxl) 创建 Excel 文件
 *
 * Tier: core | Category: file
 * 依赖: python3 + openpyxl
 */

import { z } from "zod";
import { resolve, isAbsolute } from "path";
import { writeFile, unlink, stat } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const xlsxCreateTool = {
  name: "xlsx_create",
  description: "TOOL_XLSX_CREATE_DESC",
  systemHint: "TOOL_XLSX_CREATE_HINT",
  briefDescription: "TOOL_XLSX_CREATE_BRIEF",  // 注意：原始代码中值为 TOOL_XLSX_RECALC_BRIEF（疑似 bug）
  category: "file" as const,
  tier: "core" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 10000,

  inputSchema: z.object({
    code: z.string().describe("用于生成 Excel 的 Python 代码（使用 openpyxl 库）"),
    output_path: z.string().describe("输出的 .xlsx 文件路径"),
  }),

  async execute(
    { code, output_path }: { code: string; output_path: string },
    context: { workdir: string }
  ) {
    const outputPath = isAbsolute(output_path) ? output_path : resolve(context.workdir, output_path);
    const tmpPyFile = resolve(context.workdir, "_alice_xlsx_tmp.py");

    try {
      // ── 1. 将 Python 代码写入临时文件 ──
      await writeFile(tmpPyFile, code, "utf-8");

      // ── 2. 执行 Python 脚本 ──
      const { stdout, stderr } = await execFileAsync("python3", [tmpPyFile], {
        cwd: context.workdir,
        timeout: 60000,
      });

      // ── 3. 清理临时文件 ──
      try { await unlink(tmpPyFile); } catch {}

      // ── 4. 验证输出文件存在 ──
      try {
        await stat(outputPath);
      } catch {
        return {
          type: "error" as const,
          error: `Python 执行完毕但输出文件未生成：${outputPath}\n${stderr?.trim() || stdout?.trim() || "未知原因"}`,
        };
      }

      return {
        type: "success" as const,
        content: `Excel 文件已生成：${outputPath}${stdout?.trim() ? `\n输出：${stdout.trim()}` : ""}`,
      };
    } catch (err: any) {
      // 清理临时文件
      try { await unlink(tmpPyFile); } catch {}
      return {
        type: "error" as const,
        error: `Python 执行失败：${err.stderr?.trim?.() || err.message || String(err)}`,
      };
    }
  },
};
