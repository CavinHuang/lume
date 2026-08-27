/**
 * 文件路径安全原语(#177 自 agent-files-service.ts 拆出,纯移动):
 * 供线程/工作区文件服务与 FileRef 授权层共用的段校验与包含判定。
 */
import { join, resolve, sep } from "node:path";
import { getAgentWorkspacePath } from "../infra/config-paths";

export function validatePathSegment(value: string, label: string): string {
  // 强版纵深防御(#531 收敛)：正则放行纯点段，"." / ".." 必须显式拒绝。
  if (!/^[a-zA-Z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} 非法`);
  }
  return value;
}

/** 统一包含判定原语(#531 收敛 3 份拷贝)。Windows 跨盘符逃逸检测不可删：
 *  不同盘符前缀必不匹配前缀判定，天然拒绝 C:\a → D:\b 逃逸。 */
export function isWithin(basePath: string, targetPath: string): boolean {
  const base = resolve(basePath);
  const target = resolve(targetPath);
  if (process.platform === "win32") {
    const b = base.toLowerCase();
    const t = target.toLowerCase();
    return t === b || t.startsWith(`${b}${sep}`);
  }
  return target === base || target.startsWith(`${base}${sep}`);
}
export function resolveWorkspaceResourcesDir(workspaceSlug: string): string {
  validatePathSegment(workspaceSlug, "workspaceSlug");
  return join(getAgentWorkspacePath(workspaceSlug), "resources");
}
