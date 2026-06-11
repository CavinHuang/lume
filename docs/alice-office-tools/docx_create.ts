/**
 * docx_create - 使用 docx 库创建 Word 文档
 *
 * Tier: core | Category: file
 * 依赖: docx (^9.6.1) npm 包
 */

import { z } from "zod";
import { mkdirSync } from "fs";
import { dirname, resolve, isAbsolute } from "path";

// ============================================================
// 工具定义
// ============================================================
export const docxCreateTool = {
  name: "docx_create",
  description: "TOOL_DOCX_CREATE_DESC",         // i18n key
  systemHint: "TOOL_DOCX_CREATE_HINT",           // 系统提示 i18n key
  briefDescription: "TOOL_DOCX_CREATE_BRIEF",    // 简短描述 i18n key
  category: "file" as const,
  tier: "core" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 5000,

  inputSchema: z.object({
    code: z.string().optional().describe("用于生成 DOCX 的 JavaScript 代码（使用 docx 库）"),
    code_file: z.string().optional().describe("包含生成代码的 JS 文件路径"),
    output_path: z.string().describe("输出的 .docx 文件路径"),
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
      // 将用户的代码包装在 async IIFE 中，注入 docx 库和文件系统操作
      const wrappedCode = `
const docx = await import('docx');
const fs = await import('fs/promises');
const { mkdir: mkdirAsync } = fs;
const { dirname: dirnameFn } = await import('path');
const outputPath = ${JSON.stringify(outputPath)};
await mkdirAsync(dirnameFn(outputPath), { recursive: true });

${userCode}
`;
      const fn = new Function("return (async () => {" + wrappedCode + "})()");
      await fn();

      // ── 4. 验证输出文件 ──
      const { existsSync, statSync } = await import("fs");
      if (existsSync(outputPath)) {
        const lines = [
          "DOCX 文件已生成",
          "",
          "| 项目 | 值 |",
          "|------|------|",
          `| 输出路径 | ${outputPath} |`,
          `| 文件大小 | ${(statSync(outputPath).size / 1024).toFixed(1)} KB |`,
        ];

        if (code_file) {
          lines.push(`| 代码文件 | ${codeSource} |`);
          lines.push("", "如需修改，用 edit_file 修改代码文件后重新执行 docx_create（传同一个 code_file）。");
        }

        lines.push("", "如需微调，可用 office_unpack 解包后编辑 XML，再 office_pack 打包。");
        return { type: "success" as const, content: lines.join("\n") };
      }

      return {
        type: "error" as const,
        error: "代码执行完成但未找到输出文件。请确保代码末尾有 await fs.writeFile(outputPath, buffer)",
      };
    } catch (err: any) {
      const hint = code_file
        ? `\n\n代码文件：${code_file}\n用 edit_file 修改后重新执行 docx_create 即可。`
        : "";
      return {
        type: "error" as const,
        error: [
          `DOCX 创建失败：${err.message}`,
          "",
          "常见原因：",
          "- 缺少 Packer.toBuffer(doc)",
          "- ImageRun 缺少 type 参数",
          "- 表格 ShadingType 用了 SOLID",
          "- PageBreak 没有包在 Paragraph 里",
          hint,
        ].join("\n"),
      };
    }
  },
};
