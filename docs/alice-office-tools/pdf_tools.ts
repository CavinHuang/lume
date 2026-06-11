/**
 * pdf_tools - PDF 操作工具（合并/拆分/旋转/水印/加密/提取图片）
 *
 * Tier: ondemand | Category: file
 * 依赖: python3 + pypdf
 *
 * 原始源码位置: runtime-Biw3JkjY.js -> om={name:"pdf_tools",...}
 * 变量映射:
 *   o = path.isAbsolute      s = path.extname
 *   r = path.join            n = path.dirname
 *   u = path.basename        sm = resolvePath helper
 *   vn = fs/promises.writeFile
 *   En = fs/promises.unlink
 *   rm = promisify(execFile)  (ie = child_process.execFile)
 *   Q = zod (z)
 */

import { z } from "zod";
import { join, isAbsolute, dirname, basename } from "path";
import { writeFile, unlink } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * 路径解析辅助：绝对路径直接返回，相对路径拼接 workdir
 * 对应原始代码: function sm(e,t){return o(e)?e:r(t,e)}
 */
function resolvePath(p: string | undefined, workdir: string): string {
  if (!p) return "";
  return isAbsolute(p) ? p : join(workdir, p);
}

export const pdf_tools = {
  name: "pdf_tools",
  description: "TOOL_PDF_TOOLS_DESC",
  briefDescription: "TOOL_PDF_TOOLS_BRIEF",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  maxResultSizeChars: 10000,

  inputSchema: z.object({
    action: z
      .enum(["merge", "split", "rotate", "watermark", "encrypt", "extract_images"])
      .describe("TOOL_PDF_TOOLS_PARAM_ACTION"),
    files: z.array(z.string()).optional().describe("TOOL_PDF_TOOLS_PARAM_FILES"),
    file_path: z.string().optional().describe("TOOL_PDF_TOOLS_PARAM_FILE_PATH"),
    output_path: z.string().optional().describe("TOOL_PDF_TOOLS_PARAM_OUTPUT_PATH"),
    rotation: z.number().optional().describe("TOOL_PDF_TOOLS_PARAM_TH"),
    watermark_path: z.string().optional().describe("TOOL_PDF_TOOLS_PARAM_WATERMARK_PATH"),
    user_password: z.string().optional().describe("TOOL_PDF_TOOLS_PARAM_USER_PASSWORD"),
    owner_password: z.string().optional().describe("TOOL_PDF_TOOLS_PARAM_OWNER_PASSWORD"),
  }),

  async execute(
    params: {
      action: "merge" | "split" | "rotate" | "watermark" | "encrypt" | "extract_images";
      files?: string[];
      file_path?: string;
      output_path?: string;
      rotation?: number;
      watermark_path?: string;
      user_password?: string;
      owner_password?: string;
    },
    context: { workdir: string }
  ) {
    const { action } = params;
    let pythonCode: string;

    switch (action) {
      // ── 合并 ──
      // 原始: sm(e.files.map(e=>sm(e,t.workdir)), sm(e.output_path||"merged.pdf", t.workdir))
      case "merge": {
        if (!params.files?.length) {
          return { type: "error" as const, error: "merge 操作需要提供 files 参数（至少 2 个文件）" };
        }
        if (params.files.length < 2) {
          return {
            type: "error" as const,
            error: `merge 操作至少需要 2 个文件，当前只提供了 ${params.files.length} 个。请再提供至少 1 个 PDF 文件路径。`,
          };
        }
        const files = params.files.map((f) => resolvePath(f, context.workdir));
        const output = resolvePath(params.output_path || "merged.pdf", context.workdir);
        pythonCode = genMergeCode(files, output);
        break;
      }

      // ── 拆分 ──
      // 原始: sm(e.file_path,t.workdir) -> output: e.output_path ? sm(e.output_path,t.workdir) : r(n(s),`${u(s,".pdf")}_pages`)
      case "split": {
        if (!params.file_path) {
          return { type: "error" as const, error: "split 操作需要提供 file_path 参数" };
        }
        const input = resolvePath(params.file_path, context.workdir);
        const output = params.output_path
          ? resolvePath(params.output_path, context.workdir)
          : join(dirname(input), `${basename(input, ".pdf")}_pages`);
        pythonCode = genSplitCode(input, output);
        break;
      }

      // ── 旋转 ──
      // 原始: sm(e.output_path||e.file_path, t.workdir), rotation ?? 90
      case "rotate": {
        if (!params.file_path) {
          return { type: "error" as const, error: "rotate 操作需要提供 file_path 参数" };
        }
        const input = resolvePath(params.file_path, context.workdir);
        const output = resolvePath(params.output_path || params.file_path, context.workdir);
        const degrees = params.rotation ?? 90;
        pythonCode = genRotateCode(input, degrees, output);
        break;
      }

      // ── 水印 ──
      // 原始: i=sm(e.output_path||e.file_path,t.workdir)
      case "watermark": {
        if (!params.file_path || !params.watermark_path) {
          return {
            type: "error" as const,
            error: "watermark 操作需要提供 file_path 和 watermark_path 参数",
          };
        }
        const input = resolvePath(params.file_path, context.workdir);
        const wmPath = resolvePath(params.watermark_path, context.workdir);
        const output = resolvePath(params.output_path || params.file_path, context.workdir);
        pythonCode = genWatermarkCode(input, wmPath, output);
        break;
      }

      // ── 加密 ──
      // 原始: sm(e.output_path||e.file_path, t.workdir), owner_password = e.owner_password || s (where s = user_password || "")
      case "encrypt": {
        if (!params.file_path) {
          return { type: "error" as const, error: "encrypt 操作需要提供 file_path 参数" };
        }
        const input = resolvePath(params.file_path, context.workdir);
        const output = resolvePath(params.output_path || params.file_path, context.workdir);
        const userPwd = params.user_password || "";
        const ownerPwd = params.owner_password || userPwd;
        pythonCode = genEncryptCode(input, output, userPwd, ownerPwd);
        break;
      }

      // ── 提取图片 ──
      // 原始: output = e.output_path ? sm(e.output_path,t.workdir) : r(n(s),`${u(s,".pdf")}_images`)
      case "extract_images": {
        if (!params.file_path) {
          return { type: "error" as const, error: "extract_images 操作需要提供 file_path 参数" };
        }
        const input = resolvePath(params.file_path, context.workdir);
        const output = params.output_path
          ? resolvePath(params.output_path, context.workdir)
          : join(dirname(input), `${basename(input, ".pdf")}_images`);
        pythonCode = genExtractImagesCode(input, output);
        break;
      }

      default:
        return { type: "error" as const, error: `不支持的操作：${action}` };
    }

    // ── 执行生成的 Python 代码 ──
    // 原始: const a = r(t.workdir, "_alice_pdf_tools_tmp.py")
    const tmpPyFile = join(context.workdir, "_alice_pdf_tools_tmp.py");

    try {
      // await vn(a, o, "utf-8")
      await writeFile(tmpPyFile, pythonCode, "utf-8");

      // const { stdout: e, stderr: n } = await rm("python3", [a], { cwd: t.workdir, timeout: 6e4 })
      const { stdout, stderr } = await execFileAsync("python3", [tmpPyFile], {
        cwd: context.workdir,
        timeout: 60000,
      });

      // try { await En(a) } catch {}
      try {
        await unlink(tmpPyFile);
      } catch {}

      // const r = e?.trim() || ""; const s = n?.trim() || ""
      // return s && !r ? error : success with warnings
      const out = stdout?.trim() || "";
      const err = stderr?.trim() || "";
      if (err && !out) {
        return { type: "error" as const, error: err };
      }
      return {
        type: "success" as const,
        content: out + (err ? `\n[warnings]\n${err}` : ""),
      };
    } catch (err: any) {
      try {
        await unlink(tmpPyFile);
      } catch {}
      return {
        type: "error" as const,
        error: `PDF 操作失败：${err.stderr?.trim?.() || err.message || String(err)}`,
      };
    }
  },
};

// ============================================================
// Python 代码生成函数 — 与原始压缩代码精确对应
// ============================================================

/**
 * 合并 PDF
 * 原始: function(e,t){ const n=e.map(e=>`    r"${e}"`).join(",\n"); ... }
 */
function genMergeCode(files: string[], output: string): string {
  const fileList = files.map((f) => `    r"${f}"`).join(",\n");
  return `
from pypdf import PdfWriter
writer = PdfWriter()
for path in [
${fileList}
]:
    writer.append(path)
writer.write(r"${output}")
writer.close()
print(f"已合并 ${files.length} 个文件 -> ${output}")
`.trim();
}

/**
 * 拆分 PDF（每页一个文件）
 * 原始: function(e,t){ ... PdfReader(r"${e}") ... }
 */
function genSplitCode(input: string, outputDir: string): string {
  return `
from pypdf import PdfReader, PdfWriter
import os
reader = PdfReader(r"${input}")
os.makedirs(r"${outputDir}", exist_ok=True)
base = os.path.splitext(os.path.basename(r"${input}"))[0]
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    out = os.path.join(r"${outputDir}", f"{base}_page{i+1}.pdf")
    writer.write(out)
    writer.close()
print(f"已拆分为 {len(reader.pages)} 个文件 -> ${outputDir}")
`.trim();
}

/**
 * 旋转 PDF 页面
 * 原始: function(e,t,n){ ... page.rotate(${t}) ... }
 */
function genRotateCode(input: string, degrees: number, output: string): string {
  return `
from pypdf import PdfReader, PdfWriter
reader = PdfReader(r"${input}")
writer = PdfWriter()
for page in reader.pages:
    page.rotate(${degrees})
    writer.add_page(page)
writer.write(r"${output}")
writer.close()
print(f"已旋转 {len(reader.pages)} 页（${degrees}°）-> ${output}")
`.trim();
}

/**
 * 添加水印
 * 原始: 直接内联模板字符串，使用 page.merge_page(watermark)
 */
function genWatermarkCode(input: string, watermark: string, output: string): string {
  return `
from pypdf import PdfReader, PdfWriter
reader = PdfReader(r"${input}")
watermark = PdfReader(r"${watermark}").pages[0]
writer = PdfWriter()
for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)
writer.write(r"${output}")
writer.close()
print(f"已添加水印 -> ${output}")
`.trim();
}

/**
 * 加密 PDF
 * 原始: function(e,t,n,r){ ... writer.encrypt(user_password=r"${n}", owner_password=r"${r}") ... }
 */
function genEncryptCode(
  input: string,
  output: string,
  userPwd: string,
  ownerPwd: string
): string {
  return `
from pypdf import PdfReader, PdfWriter
reader = PdfReader(r"${input}")
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
writer.encrypt(user_password=r"${userPwd}", owner_password=r"${ownerPwd}")
writer.write(r"${output}")
writer.close()
print(f"已加密 -> ${output}")
`.trim();
}

/**
 * 提取 PDF 中所有图片
 * 原始: function(e,t){ ... for j, image in enumerate(page.images): ... }
 */
function genExtractImagesCode(input: string, outputDir: string): string {
  return `
from pypdf import PdfReader
import os
reader = PdfReader(r"${input}")
os.makedirs(r"${outputDir}", exist_ok=True)
count = 0
for i, page in enumerate(reader.pages):
    for j, image in enumerate(page.images):
        ext = os.path.splitext(image.name)[1] or '.png'
        out = os.path.join(r"${outputDir}", f"page{i+1}_img{j+1}{ext}")
        with open(out, 'wb') as f:
            f.write(image.data)
        count += 1
print(f"已提取 {count} 张图片 -> ${outputDir}")
`.trim();
}
