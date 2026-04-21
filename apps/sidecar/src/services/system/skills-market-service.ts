import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  GetSkillMarketCatalogInput,
  GlobalSkillMeta,
  SkillCatalogItem,
  SkillMarketCatalogResult,
  SkillMeta
} from "@lume/shared";
import { getWorkspaceSkills } from "../agent/agent-workspace-manager";
import { getDefaultSkillsDir } from "../infra/config-paths";
import { getGlobalDiscoverySnapshot } from "./global-discovery-service";
import { seedDefaultSkills } from "./default-skills-seeder";
import { getInstalledSkillSourceMetadata } from "./skills-market-metadata";

const SOURCE_PRIORITY: Record<SkillCatalogItem["sourceType"], number> = {
  "built-in": 0,
  local: 1,
  github: 2,
  "subscribed-market": 3
};

const TRUST_PRIORITY: Record<SkillCatalogItem["trustLevel"], number> = {
  trusted: 0,
  "review-required": 1,
  "blocked-by-default": 2
};

function parseSkillFrontmatter(content: string, slug: string): SkillMeta {
  const meta: SkillMeta = { slug, name: slug };
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return meta;

  const frontmatter = frontmatterMatch[1] ?? "";
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key === "name" && value) meta.name = value;
    if (key === "description" && value) meta.description = value;
    if (key === "icon" && value) meta.icon = value;
    if (key === "version" && value) meta.version = value;
  }

  return meta;
}

function readSkillsFromDir(skillsDir: string): SkillMeta[] {
  if (!existsSync(skillsDir)) return [];

  const skills: SkillMeta[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    try {
      skills.push(parseSkillFrontmatter(readFileSync(skillMdPath, "utf-8"), entry.name));
    } catch {
      console.warn(`[Skills Market] 解析 skill 失败: ${entry.name}`);
    }
  }
  return skills;
}

function normalizeBuiltInSkills(skills: SkillMeta[]): SkillCatalogItem[] {
  return skills.map((skill) => ({
    id: `built-in:${skill.slug}`,
    sourceId: `built-in:${skill.slug}`,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    version: skill.version,
    sourceType: "built-in",
    trustLevel: "trusted",
    installState: "not-installed"
  }));
}

function normalizeGlobalSkills(skills: GlobalSkillMeta[]): SkillCatalogItem[] {
  return skills.map((skill) => ({
    id: skill.id,
    sourceId: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    sourceType: "local",
    trustLevel: "trusted",
    installState: "not-installed"
  }));
}

function compareCatalogItems(a: SkillCatalogItem, b: SkillCatalogItem): number {
  return (
    TRUST_PRIORITY[a.trustLevel] - TRUST_PRIORITY[b.trustLevel] ||
    SOURCE_PRIORITY[a.sourceType] - SOURCE_PRIORITY[b.sourceType] ||
    a.name.localeCompare(b.name, "zh-CN")
  );
}

function buildSkillMarketCatalog(input: {
  sources: SkillCatalogItem[];
  workspaceSkills: Array<Pick<SkillMeta, "slug" | "name" | "description" | "icon" | "version">>;
  installedSourceMetadata?: Record<string, {
    sourceType: SkillCatalogItem["sourceType"];
    trustLevel: SkillCatalogItem["trustLevel"];
  }>;
  includeBlockedSources?: boolean;
}): SkillMarketCatalogResult {
  const bySlug = new Map<string, SkillCatalogItem>();

  for (const source of input.sources) {
    if (!input.includeBlockedSources && source.trustLevel === "blocked-by-default") {
      continue;
    }
    const existing = bySlug.get(source.slug);
    if (!existing || SOURCE_PRIORITY[source.sourceType] < SOURCE_PRIORITY[existing.sourceType]) {
      bySlug.set(source.slug, { ...source, installState: "not-installed" });
    }
  }

  for (const workspaceSkill of input.workspaceSkills) {
    const installedSourceMeta = input.installedSourceMetadata?.[workspaceSkill.slug];
    const existing = bySlug.get(workspaceSkill.slug);
    if (existing) {
      if (installedSourceMeta) {
        existing.sourceType = installedSourceMeta.sourceType;
        existing.trustLevel = installedSourceMeta.trustLevel;
      }
      existing.installState = "installed";
      if (!existing.version && workspaceSkill.version) {
        existing.version = workspaceSkill.version;
      }
      continue;
    }

    bySlug.set(workspaceSkill.slug, {
      id: `workspace:${workspaceSkill.slug}`,
      slug: workspaceSkill.slug,
      name: workspaceSkill.name,
      description: workspaceSkill.description,
      icon: workspaceSkill.icon,
      version: workspaceSkill.version,
      sourceType: installedSourceMeta?.sourceType ?? "local",
      trustLevel: installedSourceMeta?.trustLevel ?? "trusted",
      installState: "installed"
    });
  }

  return {
    items: [...bySlug.values()].sort(compareCatalogItems)
  };
}

export function getSkillMarketCatalog(input: GetSkillMarketCatalogInput): SkillMarketCatalogResult {
  seedDefaultSkills();

  const builtInSkills = normalizeBuiltInSkills(readSkillsFromDir(getDefaultSkillsDir()));
  const globalSkills = normalizeGlobalSkills(getGlobalDiscoverySnapshot().skills);
  const workspaceSkills = getWorkspaceSkills(input.workspaceSlug);
  const installedSourceMetadata = getInstalledSkillSourceMetadata(input.workspaceSlug);

  return buildSkillMarketCatalog({
    sources: [...builtInSkills, ...globalSkills],
    workspaceSkills,
    installedSourceMetadata,
    includeBlockedSources: input.includeBlockedSources
  });
}

export const __internal = {
  buildSkillMarketCatalog,
  normalizeBuiltInSkills,
  normalizeGlobalSkills,
  readSkillsFromDir
};
