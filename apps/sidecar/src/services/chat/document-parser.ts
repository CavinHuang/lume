
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { resolveAttachmentPath } from "../infra/config-paths";

const TEXT_EXTS = new Set([".txt", ".md", ".json", ".ts", ".tsx", ".js", ".jsx", ".rs", ".py", ".yml", ".yaml"]);

export function isDocumentAttachment(mediaType: string): boolean {
  if (mediaType.startsWith("image/")) return false;
  return true;
}

export async function extractTextFromAttachment(localPath: string): Promise<string> {
  const fullPath = resolveAttachmentPath(localPath);
  const ext = extname(fullPath).toLowerCase();
  if (!TEXT_EXTS.has(ext)) {
    return "[暂不支持该文件格式的文本提取]";
  }
  try {
    return readFileSync(fullPath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return `[文件读取失败: ${message}]`;
  }
}
