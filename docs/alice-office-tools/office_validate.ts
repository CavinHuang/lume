/**
 * office_validate - 校验 Office 文档 XML 结构
 *
 * Tier: ondemand | Category: file | isConcurrencySafe: true
 * 依赖: python3.11 + office-scripts/office/validate.py
 *
 * 原始源码位置: runtime-Biw3JkjY.js -> Fd={name:"office_validate",...}
 * 变量映射:
 *   o = path.isAbsolute
 *   r = path.join (或 path.resolve)
 *   od = validateOfficeDir() 核心校验函数
 */

import { z } from "zod";
import { resolve, isAbsolute } from "path";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const OFFICE_SCRIPTS_DIR = resolve(__dirname, "..", "office-scripts");
const OFFICE_DIR = resolve(OFFICE_SCRIPTS_DIR, "office");
const VALIDATE_PY = resolve(OFFICE_DIR, "validate.py");

interface ValidateResult {
  allPassed: boolean;
  totalErrors: number;
  checks: Array<{ name: string; passed: boolean; errors: string[] }>;
}

// 导出校验函数供 office_pack 使用
export async function validateOfficeDir(dirPath: string, originalPath?: string): Promise<ValidateResult> {
  if (!existsSync(dirPath)) throw new Error(`目录不存在：${dirPath}`);

  const args = [VALIDATE_PY, dirPath];
  if (originalPath) args.push("--original", originalPath);

  let stdout: string;
  try {
    const result = await execFileAsync("python3.11", args, {
      cwd: OFFICE_DIR,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: any) {
    const stderr = err.stderr?.trim?.() || "";
    const out = err.stdout?.trim?.() || "";
    throw new Error(`validate.py 执行失败：${stderr || out || err.message || String(err)}`);
  }

  try {
    return JSON.parse(stdout.trim());
  } catch {
    // 如果不是 JSON，尝试从文本中解析
    return {
      allPassed: !stdout.includes("Error") && !stdout.includes("error"),
      totalErrors: 0,
      checks: [],
    };
  }
}

export const officeValidateTool = {
  name: "office_validate",
  description: "TOOL_OFFICE_VALIDATE_DESC",
  briefDescription: "TOOL_OFFICE_VALIDATE_BRIEF",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  maxResultSizeChars: 20000,

  inputSchema: z.object({
    dir_path: z.string().describe("已解压的 Office 文档目录路径"),
    original_path: z.string().optional().describe("原始文件路径（用于对比校验）"),
  }),

  async execute(
    { dir_path, original_path }: { dir_path: string; original_path?: string },
    context: { workdir: string }
  ) {
    try {
      const absDirPath = isAbsolute(dir_path) ? dir_path : resolve(context.workdir, dir_path);
      const absOriginalPath = original_path
        ? (isAbsolute(original_path) ? original_path : resolve(context.workdir, original_path))
        : undefined;

      const result = await validateOfficeDir(absDirPath, absOriginalPath);

      // ── 构建返回信息 ──
      const lines = [
        result.allPassed
          ? "校验通过，未发现问题。"
          : `校验完成，发现 ${result.totalErrors} 个问题。`,
        "",
      ];

      for (const check of result.checks) {
        const icon = check.passed ? "✅" : "❌";
        lines.push(`### ${icon} ${check.name}`);

        if (check.errors.length > 0) {
          for (const err of check.errors.slice(0, 20)) lines.push(`- ${err}`);
          if (check.errors.length > 20) lines.push(`- …还有 ${check.errors.length - 20} 个错误`);
        }
        lines.push("");
      }

      return { type: "success" as const, content: lines.join("\n") };
    } catch (err: any) {
      return { type: "error" as const, error: `校验失败：${err.message}` };
    }
  },
};
