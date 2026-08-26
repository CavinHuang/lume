import type { CodingFileRevertResult, CodingRunRevertResult } from "./types/runtime-event";

/**
 * 快照还原结果文案（#714）：桌面审阅面板 notice 与 IM /revert 回复共用，
 * 保证桶计数口径单源。
 */

/** Run 级还原结果摘要：按桶计数拼一句提示文案 */
export function formatCodingRevertSummary(
  result: Pick<CodingRunRevertResult, "filesChanged" | "conflicts" | "committedPaths" | "failedFiles">,
): string {
  const parts = [`已还原 ${result.filesChanged.length} 个文件`];
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} 个因 Run 后被外部修改而跳过`);
  if (result.committedPaths.length > 0) parts.push(`${result.committedPaths.length} 个已提交不可回退`);
  if (result.failedFiles.length > 0) parts.push(`${result.failedFiles.length} 个还原失败`);
  return parts.join("；");
}

/** 单文件还原结果的失败提示；restored 返回 null（调用方走成功提示） */
export function formatCodingFileRevertNotice(result: CodingFileRevertResult): string | null {
  if (result.status === "committed_boundary") return "该文件已提交到 Git，无法按快照回退";
  if (result.status === "conflict") return "该文件在 Run 后被外部修改，未按快照覆盖";
  return null;
}
