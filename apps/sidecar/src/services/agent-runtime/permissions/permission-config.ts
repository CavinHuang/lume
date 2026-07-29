import type { LumeConfigPermissionsSection } from "@lume/shared";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  getAliceUserSkillsDir,
  getDefaultSkillsDir,
  getUserSkillsDir,
  getWorkspaceSkillsDir
} from "../../infra/config-paths";
import type { PermissionRule } from "./permission-types";

export function resolveConfiguredPermissionRules(
  permissions?: LumeConfigPermissionsSection
): PermissionRule[] {
  return (permissions?.rules ?? []).map((rule) => ({
    ...rule,
    scope: rule.scope ?? "workspace"
  }));
}

export function resolveConfiguredPrivateWriteRoots(input: {
  agentCwd: string;
  lumeWorkDir?: string;
  filesRoot?: string;
  plansRoot?: string;
  artifactsRoot?: string;
  workspaceSlug?: string;
  configuredRoots?: string[];
}): string[] {
  const managedRoot = input.lumeWorkDir ?? input.agentCwd;
  const roots = [
    join(managedRoot, ".lume"),
    input.plansRoot ?? join(managedRoot, "plans"),
    input.artifactsRoot ?? join(managedRoot, "artifacts"),
    input.filesRoot ?? join(managedRoot, "files"),
    join(homedir(), ".lume", "plugins"),
    getDefaultSkillsDir(),
    getUserSkillsDir(),
    getAliceUserSkillsDir(),
    ...(input.workspaceSlug ? [getWorkspaceSkillsDir(input.workspaceSlug)] : []),
    ...resolveConfiguredAdditionalDirectories(input.configuredRoots, input.agentCwd)
  ];
  return Array.from(new Set(roots.filter((root) => root.trim().length > 0)));
}

export function resolveConfiguredAdditionalDirectories(
  roots: string[] | undefined,
  cwd: string,
): string[] {
  return [...new Set((roots ?? [])
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => resolvePrivateRoot(root, cwd)))];
}

function resolvePrivateRoot(root: string, cwd: string): string {
  const trimmed = root.trim();
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}
