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
  workspaceSlug?: string;
  configuredRoots?: string[];
}): string[] {
  const roots = [
    join(input.agentCwd, ".lume"),
    join(input.agentCwd, "plans"),
    join(input.agentCwd, "artifacts"),
    join(input.agentCwd, "files"),
    join(homedir(), ".lume", "plugins"),
    getDefaultSkillsDir(),
    getUserSkillsDir(),
    getAliceUserSkillsDir(),
    ...(input.workspaceSlug ? [getWorkspaceSkillsDir(input.workspaceSlug)] : []),
    ...(input.configuredRoots ?? []).map((root) => resolvePrivateRoot(root, input.agentCwd))
  ];
  return Array.from(new Set(roots.filter((root) => root.trim().length > 0)));
}

function resolvePrivateRoot(root: string, cwd: string): string {
  const trimmed = root.trim();
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}
