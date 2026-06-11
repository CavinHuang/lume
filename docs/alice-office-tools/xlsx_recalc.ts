/**
 * xlsx_recalc - 重新计算 Excel 公式
 *
 * Tier: ondemand | Category: file
 * 依赖: python3 + office-scripts/recalc.py
 */

import { z } from "zod";
import { resolve, isAbsolute } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// recalc.py 路径（相对于当前模块）
const RECALC_PY = resolve(__dirname, "..", "office-scripts", "recalc.py");

export const xlsxRecalcTool = {
  name: "xlsx_recalc",
  description: "TOOL_XLSX_RECALC_DESC",
  briefDescription: "TOOL_XLSX_RECALC_BRIEF",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  maxResultSizeChars: 10000,

  inputSchema: z.object({
    file_path: z.string().describe("需要重新计算的 .xlsx 文件路径"),
    timeout: z.number().optional().default(30).describe("超时时间（秒），默认 30"),
  }),

  async execute(
    { file_path, timeout = 30 }: { file_path: string; timeout?: number },
    context: { workdir: string }
  ) {
    const absPath = isAbsolute(file_path) ? file_path : resolve(context.workdir, file_path);

    try {
      const { stdout, stderr } = await execFileAsync("python3", [RECALC_PY, absPath], {
        cwd: context.workdir,
        timeout: 1000 * timeout,  // 秒转毫秒
      });

      const output = stdout.trim();
      if (!output) {
        return {
          type: "error" as const,
          error: `recalc 脚本异常：${stderr?.trim() || "脚本无输出"}`,
        };
      }

      // 尝试解析 JSON 结果
      try {
        const result = JSON.parse(output);
        if (result.error) {
          return { type: "error" as const, error: result.error };
        }
        return { type: "success" as const, content: JSON.stringify(result, null, 2) };
      } catch {
        // 非 JSON 输出，直接返回原始文本
        return { type: "success" as const, content: output };
      }
    } catch (err: any) {
      return {
        type: "error" as const,
        error: `recalc 执行失败：${err.stderr?.trim?.() || err.message || String(err)}`,
      };
    }
  },
};
