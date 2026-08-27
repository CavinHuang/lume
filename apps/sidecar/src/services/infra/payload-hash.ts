import { createHash } from "node:crypto";

/**
 * 稳定载荷指纹：sha256(JSON.stringify(value ?? null))。
 *
 * 这是「写入 ↔ 恢复」跨文件配对契约的唯一实现(#531 收敛 5 处拷贝)：
 * - 写入侧：runtime-core/run.ts 后台 continuation checkpoint 持久化
 * - 恢复侧：runtime-core/run.ts 冷启动校验、runner/lume-runner.ts
 *   continuation permission handler、interruption 两侧 session
 * 任何一侧改动算法都会静默破坏恢复配对——勿在调用点内联此表达式。
 */
export function stableHashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}
