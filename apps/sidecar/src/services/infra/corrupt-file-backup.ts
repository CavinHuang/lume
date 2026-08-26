import { randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { createLogger } from "./logger";

const log = createLogger("corrupt-file-backup");

/**
 * 损坏文件检疫备份的唯一收口：原子改名保留现场，返回备份路径。
 *
 * 文件不存在或改名失败返回 null（调用方按各自语义决定重建/报错）。
 * 改名失败必须在此处统一留痕：Windows 上 AV/索引器瞬时持锁即可失败，静默
 * 重建空库等于数据无痕丢失。命名必须带随机段：纯 Date.now() 在快速连续损坏（重启循环/高频写）下同毫秒
 * 同名，rename 覆盖上一代——恰丢唯一数据副本（#686 在 automation 的 CI 实证；
 * 本工具收口其余九个同型 store）。判代抑制（同内容跳过备份）是 automation 的
 * quarantine 特有语义，不在此层。
 */
export function backupCorruptFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const backupPath = `${filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(filePath, backupPath);
    return backupPath;
  } catch (error) {
    log.warn("failed to back up corrupt file; rebuilding in place", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
