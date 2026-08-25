import { isAbsolute, relative, resolve } from "node:path";

/**
 * 路径包含判定原语(#531 收敛)：coding-workspace-monitor /
 * coding-run-checkpoint-service / coding-run-tracker 三处同型 isPathInside
 * 与 coding-verification 的弱化变体 isWithinWorkspace 收敛于此（取强版本）。
 *
 * Windows 跨盘符逃逸检测不可删：跨盘时 relative() 返回绝对路径，
 * `isAbsolute(relativePath)` 兜底判 false——前缀匹配式实现没有这层保护。
 */
export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
