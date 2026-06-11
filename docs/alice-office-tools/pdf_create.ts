/**
 * pdf_create - 使用 Python (reportlab) 创建 PDF 文件
 *
 * Tier: core | Category: file
 * 依赖: python3 + reportlab
 *
 * 原始源码位置: runtime-Biw3JkjY.js -> nm={name:"pdf_create",...}
 * 变量映射:
 *   o = path.isAbsolute
 *   r = path.join
 *   vn = fs/promises.writeFile
 *   En = fs/promises.unlink
 *   Cn = fs/promises.access
 *   tm = promisify(execFile)  (ie = child_process.execFile)
 *   Q = zod (z)
 */

import { z } from "zod";
import { join, isAbsolute } from "path";
import { writeFile, unlink, access } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import type { PathLike } from "fs";

const execFileAsync = promisify(execFile);

export const pdf_create = {
  name: "pdf_create",
  description: "TOOL_PDF_CREATE_DESC",
  briefDescription: "TOOL_PDF_CREATE_BRIEF",  // 注意：原始代码中值为 TOOL_PDF_TOOLS_BRIEF（疑似 bug）
  category: "file" as const,
  tier: "core" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 5000,

  inputSchema: z.object({
    code: z.string().describe("TOOL_PDF_CREATE_PARAM_INPUTSCHEMA"),
    output_path: z.string().describe("TOOL_PDF_CREATE_PARAM_OUTPUT_PATH"),
  }),

  async execute(
    { code, output_path }: { code: string; output_path: string },
    context: { workdir: string }
  ) {
    // const s = o(t) ? t : r(n.workdir, t)
    const outputPath = isAbsolute(output_path)
      ? output_path
      : join(context.workdir, output_path);

    // const i = r(n.workdir, "_alice_pdf_tmp.py")
    const tmpPyFile = join(context.workdir, "_alice_pdf_tmp.py");

    try {
      // await vn(i, e, "utf-8")
      await writeFile(tmpPyFile, code, "utf-8");

      // const { stdout: t, stderr: r } = await tm("python3", [i], { cwd: n.workdir, timeout: 6e4 })
      const { stdout, stderr } = await execFileAsync("python3", [tmpPyFile], {
        cwd: context.workdir,
        timeout: 60000,
      });

      // try { await En(i) } catch {}
      try {
        await unlink(tmpPyFile);
      } catch {}

      // try { await Cn(s) } catch { return error }
      try {
        await access(outputPath as PathLike);
      } catch {
        return {
          type: "error" as const,
          error: `Python 执行完毕但输出文件未生成：${outputPath}\n${
            stderr?.trim() || stdout?.trim() || "未知原因"
          }`,
        };
      }

      // return { type: "success", content: `PDF 文件已生成：${s}${...}` }
      return {
        type: "success" as const,
        content: `PDF 文件已生成：${outputPath}${
          stdout?.trim() ? `\n输出：${stdout.trim()}` : ""
        }`,
      };
    } catch (err: any) {
      // try { await En(i) } catch {}
      try {
        await unlink(tmpPyFile);
      } catch {}

      return {
        type: "error" as const,
        error: `Python 执行失败：${err.stderr?.trim?.() || err.message || String(err)}`,
      };
    }
  },
};
