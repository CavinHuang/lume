/**
 * pptx_create - 使用 PptxGenJS 库创建 PowerPoint 演示文稿
 *
 * Tier: core | Category: file
 * 依赖: pptxgenjs (^4.0.1) npm 包
 */

import { z } from "zod";
import { mkdirSync } from "fs";
import { dirname, resolve, isAbsolute } from "path";

export const pptxCreateTool = {
  name: "pptx_create",
  description: "TOOL_PPTX_CREATE_DESC",
  systemHint: "TOOL_PPTX_CREATE_HINT",
  briefDescription: "TOOL_PPTX_CREATE_BRIEF",
  category: "file" as const,
  tier: "core" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 5000,

  inputSchema: z.object({
    code: z.string().optional().describe("用于生成 PPTX 的 JavaScript 代码（使用 PptxGenJS 库）"),
    code_file: z.string().optional().describe("包含生成代码的 JS 文件路径"),
    output_path: z.string().describe("输出的 .pptx 文件路径"),
  }),

  async execute(
    { code, code_file, output_path }: { code?: string; code_file?: string; output_path: string },
    context: { workdir: string }
  ) {
    try {
      let userCode: string;
      let codeSource: string;

      // ── 1. 获取代码内容 ──
      if (code_file) {
        const filePath = isAbsolute(code_file) ? code_file : resolve(context.workdir, code_file);
        try {
          const { readFile } = await import("fs/promises");
          userCode = await readFile(filePath, "utf-8");
        } catch {
          return { type: "error" as const, error: `代码文件不存在：${filePath}` };
        }
        codeSource = filePath;
      } else {
        if (!code) {
          return { type: "error" as const, error: "请提供 code 或 code_file 参数（二选一）" };
        }
        userCode = code;
        codeSource = "(inline)";
      }

      // ── 2. 解析输出路径，确保目录存在 ──
      const outputPath = isAbsolute(output_path) ? output_path : resolve(context.workdir, output_path);
      mkdirSync(dirname(outputPath), { recursive: true });

      // ── 3. 构造并执行代码 ──
      // 注入 PptxGenJS 库，预设 16:9 布局
      const wrappedCode = `
const PptxGenJS = (await import('pptxgenjs')).default;
const { mkdir: mkdirAsync } = await import('fs/promises');
const { dirname: dirnameFn } = await import('path');
const pres = new PptxGenJS();
pres.layout = 'LAYOUT_16x9';
const outputPath = ${JSON.stringify(outputPath)};
await mkdirAsync(dirnameFn(outputPath), { recursive: true });

${userCode}
`;
      const fn = new Function("return (async () => {" + wrappedCode + "})()");
      await fn();

      // ── 4. 验证输出文件 ──
      const { existsSync } = await import("fs");
      if (existsSync(outputPath)) {
        const { statSync } = await import("fs");
        const lines = [
          "PPTX 文件已生成",
          "",
          "| 项目 | 值 |",
          "|------|------|",
          `| 输出路径 | ${outputPath} |`,
          `| 文件大小 | ${(statSync(outputPath).size / 1024).toFixed(1)} KB |`,
        ];

        if (code_file) {
          lines.push(`| 代码文件 | ${codeSource} |`);
          lines.push("", "如需修改，用 edit_file 修改代码文件后重新执行 pptx_create（传同一个 code_file）。");
        }

        lines.push(
          "",
          "如需微调，可用 office_unpack 解包后编辑 XML，再 office_pack 打包。",
          "如需视觉检查，可用 office_convert 转 PDF 后 bash 调用 pdftoppm 生成图片。"
        );
        return { type: "success" as const, content: lines.join("\n") };
      }

      return {
        type: "error" as const,
        error: "代码执行完成但未找到输出文件。请确保代码末尾有 await pres.writeFile({ fileName: outputPath })",
      };
    } catch (err: any) {
      const hint = code_file
        ? `\n\n代码文件：${code_file}\n用 edit_file 修改后重新执行 pptx_create 即可。`
        : "";
      return {
        type: "error" as const,
        error: [
          `PPTX 创建失败：${err.message}`,
          "",
          "常见原因：",
          "- 颜色值带了 # 号",
          "- shadow.offset 为负数",
          "- 复用了选项对象",
          "- 缺少 await pres.writeFile()",
          hint,
        ].join("\n"),
      };
    }
  },
};
