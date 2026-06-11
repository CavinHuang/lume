/**
 * office_accept_changes - 接受 Word 文档中的所有修订（Tracked Changes）
 *
 * Tier: ondemand | Category: file | isConcurrencySafe: true
 * 依赖: python3.11 + office-scripts/accept_changes.py
 *
 * 原始源码位置: runtime-Biw3JkjY.js -> Kd={name:"office_accept_changes",...}
 * 变量映射:
 *   o = path.isAbsolute
 *   r = path.join/resolve
 *   b = fs.existsSync
 *   xd = promisify(execFile) (spawnPromise)
 *   Pd = accept_changes.py 路径
 *   Ld = office-scripts 目录
 */

import { z } from "zod";
import { resolve, isAbsolute } from "path";
import { existsSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const OFFICE_SCRIPTS_DIR = resolve(__dirname, "..", "office-scripts");
const ACCEPT_CHANGES_PY = resolve(OFFICE_SCRIPTS_DIR, "accept_changes.py");

export const officeAcceptChangesTool = {
  name: "office_accept_changes",
  description: "TOOL_OFFICE_ACCEPT_CHANGES_DESC",
  systemHint: "TOOL_XLSX_CREATE_HINT",  // 注意：原始代码引用了 xlsx_create 的 hint（疑似 copy-paste bug）
  briefDescription: "TOOL_OFFICE_ACCEPT_CHANGES_BRIEF",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  maxResultSizeChars: 5000,

  inputSchema: z.object({
    input_path: z.string().describe("含修订的 .docx 文件路径"),
    output_path: z.string().describe("接受修订后的输出文件路径"),
  }),

  async execute(
    { input_path, output_path }: { input_path: string; output_path: string },
    context: { workdir: string }
  ) {
    try {
      const absInput = isAbsolute(input_path) ? input_path : resolve(context.workdir, input_path);
      const absOutput = isAbsolute(output_path) ? output_path : resolve(context.workdir, output_path);

      const result = await acceptAllChanges(absInput, absOutput);

      return {
        type: "success" as const,
        content: [
          "修订接受完成",
          "",
          "| 项目 | 值 |",
          "|------|------|",
          `| 输入文件 | ${absInput} |`,
          `| 输出文件 | ${result.outputPath} |`,
          "",
          result.message,
        ].join("\n"),
      };
    } catch (err: any) {
      return { type: "error" as const, error: `接受修订失败：${err.message}` };
    }
  },
};

/** 调用 accept_changes.py 接受所有修订 */
async function acceptAllChanges(inputPath: string, outputPath: string) {
  if (!existsSync(inputPath)) throw new Error(`文件不存在：${inputPath}`);

  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileAsync("python3.11", [ACCEPT_CHANGES_PY, inputPath, outputPath], {
      cwd: OFFICE_SCRIPTS_DIR,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    const e = err.stderr?.trim?.() || "";
    const o = err.stdout?.trim?.() || "";
    throw new Error(`accept_changes.py 执行失败：${e || o || err.message || String(err)}`);
  }

  const combined = (stdout + stderr).trim();
  if (combined.includes("Error")) throw new Error(combined);

  return {
    outputPath,
    message: combined || "修订已全部接受",
  };
}
