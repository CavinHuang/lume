import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * 路径包含判定原语(#531 收敛)：coding-workspace-monitor /
 * coding-run-checkpoint-service / coding-run-tracker 三处同型 isPathInside
 * 与 coding-verification 的弱化变体 isWithinWorkspace 收敛于此。
 * 逃逸判定取首段精确比较：既拒绝真正的 ".." 逃逸，又不误伤 root 内恰以
 * ".." 开头的目录名（coding-verification 原弱版语义）。
 *
 * Windows 跨盘符逃逸检测不可删：跨盘时 relative() 返回绝对路径，
 * `isAbsolute(relativePath)` 兜底判 false——前缀匹配式实现没有这层保护。
 */
export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  // 逃逸判定按首段精确比较：`startsWith("..")` 会把 root 内恰以 ".." 开头的
  // 目录名（如 "..foo"）误判为工作区外（coding-verification 原弱版语义）
  const firstSegment = relativePath.split(sep)[0];
  return relativePath === "" || (firstSegment !== ".." && !isAbsolute(relativePath));
}
