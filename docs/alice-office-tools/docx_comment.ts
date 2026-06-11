/**
 * docx_comment - 向 Word 文档添加批注
 *
 * Tier: ondemand | Category: file
 * 依赖: Python 3.11 + office-scripts/comment.py
 */

import { z } from "zod";
import { resolve, isAbsolute } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// office-scripts 目录路径（相对于当前模块）
const OFFICE_SCRIPTS_DIR = resolve(__dirname, "..", "office-scripts");
const COMMENT_PY = resolve(OFFICE_SCRIPTS_DIR, "comment.py");

export const docxCommentTool = {
  name: "docx_comment",
  briefDescription: "TOOL_DOCX_COMMENT_BRIEF",
  description: "TOOL_DOCX_COMMENT_DESC",
  category: "file" as const,
  tier: "ondemand" as const,
  requiresPermission: true,
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 5000,

  inputSchema: z.object({
    dir_path: z.string().describe("已解压的 DOCX 目录路径（office_unpack 的输出）"),
    comment_id: z.number().describe("批注的唯一 ID"),
    text: z.string().describe("批注内容"),
    author: z.string().optional().describe("作者名称（默认 Alice）"),
    parent_id: z.number().optional().describe("父批注 ID（用于嵌套回复）"),
  }),

  async execute(
    { dir_path, comment_id, text, author, parent_id }: {
      dir_path: string; comment_id: number; text: string;
      author?: string; parent_id?: number;
    },
    context: { workdir: string }
  ) {
    try {
      const absDirPath = isAbsolute(dir_path) ? dir_path : resolve(context.workdir, dir_path);

      // 调用 comment.py 添加批注
      const result = await addComment({
        dirPath: absDirPath,
        commentId: comment_id,
        text,
        author: author ?? "Alice",
        initials: "A",
        parentId: parent_id,
      });

      return {
        type: "success" as const,
        content: [
          "批注添加成功",
          "",
          "| 项目 | 值 |",
          "|------|------|",
          `| 批注 ID | ${result.commentId} |`,
          `| 段落 ID | ${result.paraId} |`,
          "",
          "将以下 XML 标记插入到 word/document.xml 中目标文本的前后：",
          "",
          "**范围开始（插入到目标文本之前）：**",
          "```xml",
          result.markers.rangeStart,
          "```",
          "",
          "**范围结束 + 引用（插入到目标文本之后）：**",
          "```xml",
          result.markers.rangeEnd,
          result.markers.reference,
          "```",
        ].join("\n"),
      };
    } catch (err: any) {
      return { type: "error" as const, error: `添加批注失败：${err.message}` };
    }
  },
};

// ============================================================
// 核心实现：调用 comment.py 脚本
// ============================================================
async function addComment(params: {
  dirPath: string; commentId: number; text: string;
  author: string; initials: string; parentId?: number;
}) {
  const { dirPath, commentId, text, author = "Alice", initials = "A", parentId } = params;

  const args = [COMMENT_PY, dirPath, String(commentId), text, "--author", author, "--initials", initials];
  if (parentId !== undefined) {
    args.push("--parent", String(parentId));
  }

  let stdout: string;
  try {
    const result = await execFileAsync("python3.11", args, {
      cwd: OFFICE_SCRIPTS_DIR,
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: any) {
    const stderr = err.stderr?.trim?.() || "";
    const out = err.stdout?.trim?.() || "";
    throw new Error(`comment.py 执行失败：${stderr || out || err.message || String(err)}`);
  }

  const output = stdout.trim();
  if (output.includes("Error")) throw new Error(output);

  // 解析 para_id
  const match = output.match(/para_id=([A-F0-9]+)/i);
  const paraId = match?.[1] || "";

  return {
    commentId,
    paraId,
    markers: {
      rangeStart: `<w:commentRangeStart w:id="${commentId}"/>`,
      rangeEnd: `<w:commentRangeEnd w:id="${commentId}"/>`,
      reference: `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${commentId}"/></w:r>`,
    },
  };
}
