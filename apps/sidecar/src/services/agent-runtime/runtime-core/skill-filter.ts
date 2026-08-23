import { join } from "node:path";
import { resolve } from "node:path";
import type { AgentOptions } from "@lume/agent-sdk";
import {
  getAliceUserSkillsDir,
  getDefaultSkillsDir,
  getUserSkillsDir,
  getWorkspaceSkillsDir,
} from "../../infra/config-paths";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";

export function resolveSkillDirectories(
  cwd: string,
  workspaceSlug?: string,
): string[] {
  const roots = [
    getDefaultSkillsDir(),
    getUserSkillsDir(),
    getAliceUserSkillsDir(),
    join(cwd, ".alice", "skills"),
    join(cwd, ".lume", "skills"),
  ];
  if (workspaceSlug) {
    roots.push(getWorkspaceSkillsDir(workspaceSlug));
  }
  return roots;
}

function normalizeSkillList(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function createRuntimeSkillFilter(
  workspaceSlug?: string,
): AgentOptions["shouldLoadFilesystemSkill"] {
  if (!workspaceSlug) return undefined;

  const effectiveConfig = getEffectiveLumeConfig(workspaceSlug);
  const enabled = normalizeSkillList(effectiveConfig.skills?.enabled);
  const disabled = normalizeSkillList(effectiveConfig.skills?.disabled);
  if (enabled.size === 0 && disabled.size === 0) return undefined;

  const controlledRoots = new Set([
    resolve(getDefaultSkillsDir()),
    resolve(getWorkspaceSkillsDir(workspaceSlug)),
  ]);

  return ({ root, skillName }) => {
    if (!controlledRoots.has(resolve(root))) return true;
    if (disabled.has(skillName)) return false;
    if (enabled.size > 0 && !enabled.has(skillName)) return false;
    return true;
  };
}
