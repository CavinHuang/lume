/**
 * 文件路径安全原语(#177 自 agent-files-service.ts 拆出,纯移动):
 * 供线程/工作区文件服务与 FileRef 授权层共用的段校验与包含判定。
 */
import { join, resolve, sep } from "node:path";
import { getAgentWorkspacePath } from "../infra/config-paths";

export function validatePathSegment(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`${label} 非法`);
  }
}

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
