/**
 * office_pack - 将 XML 目录重新打包为 Office 文档
 *
 * Tier: core | Category: file
 * 依赖: python3.11 + office-scripts/office/pack.py
 *       内部调用 office_validate 进行校验（除非 skip_validate=true）
 */

import { z } from "zod";
import { resolve, isAbsolute, join } from "path";
import { readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const OFFICE_SCRIPTS_DIR = resolve(__dirname, "..", "office-scripts");
const OFFICE_DIR = resolve(OFFICE_SCRIPTS_DIR, "office");
const PACK_PY = resolve(OFFICE_DIR, "pack.py");

// 引用 validate 函数（从 office_validate 模块）
// validateOffice(dirPath: string, originalPath?: string) => ValidateResult
declare function validateOffice(dirPath: string, originalPath?: string): Promise<ValidateResult>;

interface ValidateResult {
  allPassed: boolean;
  totalErrors: number;
  checks: Array<{ name: string; passed: boolean; errors: string[] }>;
}

/** 递归统计目录中的文件数 */
async function countFilesInDir(dir: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await countFilesInDir(fullPath);
    } else {
      count++;
    }
  }
  return count;
}

export const officePackTool = {
  name: "office_pack",
  description: "TOOL_OFFICE_PACK_DESC",
  category: "file" as const,
  tier: "core" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 10000,

  inputSchema: z.object({
    dir_path: z.string().describe("已解压的 Office 文档目录路径"),
    output_path: z.string().describe("输出的 Office 文件路径"),
    original_path: z.string().optional().describe("原始文件路径（用于增量校验对比）"),
    skip_validate: z.boolean().optional().describe("是否跳过打包前的校验（默认 false）"),
  }),

  async execute(
    { dir_path, output_path, original_path, skip_validate }: {
      dir_path: string; output_path: string;
      original_path?: string; skip_validate?: boolean;
    },
    context: { workdir: string }
  ) {
    try {
      const absDirPath = isAbsolute(dir_path) ? dir_path : resolve(context.workdir, dir_path);
      const absOutputPath = isAbsolute(output_path) ? output_path : resolve(context.workdir, output_path);
      const absOriginalPath = original_path
        ? (isAbsolute(original_path) ? original_path : resolve(context.workdir, original_path))
        : undefined;

      const result = await packOfficeDocument({
        dirPath: absDirPath,
        outputPath: absOutputPath,
        originalPath: absOriginalPath,
        skipValidate: skip_validate ?? false,
      });

      // ── 构建返回信息 ──
      const lines = [
        "Office 文档打包完成",
        "",
        "| 项目 | 值 |",
        "|------|------|",
        `| 输出文件 | ${result.outputPath} |`,
        `| 打包文件数 | ${result.fileCount} |`,
      ];

      if (result.validation) {
        const v = result.validation;
        lines.push(`| 校验结果 | ${v.allPassed ? "全部通过" : `发现 ${v.totalErrors} 个问题`} |`);

        if (!v.allPassed) {
          lines.push("", "### 校验详情");
          for (const check of v.checks) {
            if (check.errors.length === 0) continue;
            lines.push("", `**${check.name}**（${check.errors.length} 个错误）`);
            for (const err of check.errors.slice(0, 10)) lines.push(`- ${err}`);
            if (check.errors.length > 10) lines.push(`- …还有 ${check.errors.length - 10} 个错误`);
          }
        }
      } else {
        lines.push("| 校验 | 已跳过 |");
      }

      return { type: "success" as const, content: lines.join("\n") };
    } catch (err: any) {
      return { type: "error" as const, error: `打包失败：${err.message}` };
    }
  },
};

// ============================================================
// 核心实现
// ============================================================
interface PackResult {
  outputPath: string;
  validation: ValidateResult | undefined;
  fileCount: number;
}

async function packOfficeDocument(params: {
  dirPath: string; outputPath: string;
  originalPath?: string; skipValidate: boolean;
}): Promise<PackResult> {
  const { dirPath, outputPath, originalPath, skipValidate } = params;

  if (!existsSync(dirPath)) throw new Error(`解压目录不存在：${dirPath}`);

  // ── 1. 可选：打包前校验 ──
  let validation: ValidateResult | undefined;
  if (!skipValidate) {
    validation = await validateOffice(dirPath, originalPath);
  }

  // ── 2. 调用 pack.py 打包 ──
  const args = [PACK_PY, dirPath, outputPath];
  if (originalPath) args.push("--original", originalPath);
  args.push("--validate", "false");  // 校验已在上层完成

  try {
    await execFileAsync("python3.11", args, {
      cwd: OFFICE_DIR,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: any) {
    const stderr = err.stderr?.trim?.() || "";
    const stdout = err.stdout?.trim?.() || "";
    throw new Error(`pack.py 执行失败：${stderr || stdout || err.message || String(err)}`);
  }

  const fileCount = await countFilesInDir(dirPath);

  return { outputPath, validation, fileCount };
}
