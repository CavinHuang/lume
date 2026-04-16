/**
 * Seed built-in default skills into ~/.lume/default-skills.
 *
 * Source priority:
 * 1) LUME_DEFAULT_SKILLS_DIR (desktop/runtime injected)
 * 2) <sidecar cwd>/default-skills (dev fallback)
 *
 * Strategy: additive sync only (do not overwrite user-customized skills).
 */

import { cpSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDefaultSkillsDir } from "../infra/config-paths";

function resolveBundledDefaultSkillsDir(): string | null {
  const fromEnv = process.env.LUME_DEFAULT_SKILLS_DIR?.trim();
  if (fromEnv) {
    return resolve(fromEnv);
  }

  const fromCwd = resolve(join(process.cwd(), "default-skills"));
  if (existsSync(fromCwd)) {
    return fromCwd;
  }

  return null;
}

export function seedDefaultSkills(): void {
  const bundledDir = resolveBundledDefaultSkillsDir();
  if (!bundledDir || !existsSync(bundledDir)) {
    console.log("[配置] 未找到内置 default-skills 目录，跳过");
    return;
  }

  const userDir = getDefaultSkillsDir();

  try {
    const entries = readdirSync(bundledDir, { withFileTypes: true });
    for (const entry of entries) {
      const source = join(bundledDir, entry.name);
      const target = join(userDir, entry.name);
      if (existsSync(target)) continue;
      cpSync(source, target, { recursive: true });
      console.log(`[配置] 已同步默认 Skill: ${entry.name}`);
    }
  } catch (error) {
    console.warn("[配置] 同步默认 Skills 失败:", error);
  }
}
