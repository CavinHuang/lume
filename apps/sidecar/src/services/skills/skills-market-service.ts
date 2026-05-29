import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  GetSkillMarketCatalogInput,
  GetSkillMarketDetailInput,
  GlobalImportResult,
  InstallSkillMarketItemToWorkspaceInput,
  ImportLocalSkillDirectoryToWorkspaceInput,
  SkillCatalogItem,
  SkillFileTreeNode,
  SkillMarketDetailResult,
  SkillMarketCatalogResult,
  SkillMeta
} from "@lume/shared";
import { getWorkspaceSkills } from "../agent/agent-workspace-manager";
import { getDefaultSkillsDir, getWorkspaceSkillsDir } from "../infra/config-paths";
import { createLogger } from "../infra/logger";
import { seedDefaultSkills } from "./default-skills-seeder";
import { getInstalledSkillSourceMetadata, saveLocalInstalledSkillMetadata, type InstalledSkillSourceMeta } from "./skills-market-metadata";

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
const log = createLogger("skills-market-service");

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
    } catch (error) {
      log.warn("skill market skill parse failed", { skillSlug: entry.name, error });
    }
  }
  return skills;
}

function discoverSkillDirsFromLocalPath(localPath: string): Array<{ slug: string; sourcePath: string }> {
  const resolvedPath = resolve(localPath);
  if (!existsSync(resolvedPath)) {
    throw new Error("本地目录不存在");
  }

  const stat = lstatSync(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error("本地路径必须是目录");
  }

  if (existsSync(join(resolvedPath, "SKILL.md"))) {
    return [{ slug: basename(resolvedPath), sourcePath: resolvedPath }];
  }

  const skillDirs = readdirSync(resolvedPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(resolvedPath, entry.name, "SKILL.md")))
    .map((entry) => ({ slug: entry.name, sourcePath: join(resolvedPath, entry.name) }))
    .sort((left, right) => left.slug.localeCompare(right.slug, "zh-CN"));

  if (skillDirs.length === 0) {
    throw new Error("没有检测到有效的 SKILL.md 或技能目录");
  }

  return skillDirs;
}

function buildFileTreeFromDir(rootPath: string, relativePath = ""): SkillFileTreeNode[] {
  const absolutePath = join(rootPath, relativePath);
  return readdirSync(absolutePath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".tmp-"))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN");
    })
    .map((entry) => {
      const nodePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: nodePath,
          type: "directory" as const,
          children: buildFileTreeFromDir(rootPath, nodePath)
        };
      }
      return {
        name: entry.name,
        path: nodePath,
        type: "file" as const,
        content: readSkillFileContent(join(rootPath, nodePath))
      };
    });
}

function readSkillFileContent(filePath: string): string {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "该文件暂不支持预览。";
  }
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

function normalizeMetadataSkillSources(metadata: Record<string, InstalledSkillSourceMeta>): SkillCatalogItem[] {
  const items: SkillCatalogItem[] = [];
  for (const [slug, meta] of Object.entries(metadata)) {
    if (meta.sourceType === "local") {
      const skillMdPath = join(meta.sourcePath, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      const parsed = parseSkillFrontmatter(readSkillFileContent(skillMdPath), slug);
      items.push({
        id: `local:skill:${slug}`,
        sourceId: `local:skill:${slug}`,
        slug,
        name: parsed.name,
        description: parsed.description,
        icon: parsed.icon,
        version: parsed.version,
        sourceType: "local",
        trustLevel: "trusted",
        installState: "not-installed"
      });
      continue;
    }

    items.push({
      id: `github:skill:${slug}`,
      sourceId: `github:skill:${slug}`,
      slug,
      name: slug,
      sourceType: "github",
      trustLevel: "review-required",
      installState: "not-installed"
    });
  }
  return items;
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
  const workspaceSkills = getWorkspaceSkills(input.workspaceSlug);
  const installedSourceMetadata = getInstalledSkillSourceMetadata(input.workspaceSlug);
  const persistedSources = normalizeMetadataSkillSources(installedSourceMetadata);

  return buildSkillMarketCatalog({
    sources: [...builtInSkills, ...persistedSources],
    workspaceSkills,
    installedSourceMetadata,
    includeBlockedSources: input.includeBlockedSources
  });
}

export function getSkillMarketDetail(input: GetSkillMarketDetailInput): SkillMarketDetailResult {
  const catalog = getSkillMarketCatalog(input);
  const item = catalog.items.find((candidate) => candidate.slug === input.skillSlug);
  if (!item) {
    throw new Error("未找到指定 Skill");
  }

  const workspaceSkillPath = join(getWorkspaceSkillsDir(input.workspaceSlug), item.slug);
  const builtInSkillPath = join(getDefaultSkillsDir(), item.slug);
  const metadataPath = (() => {
    const metadata = getInstalledSkillSourceMetadata(input.workspaceSlug)[item.slug];
    return metadata?.sourceType === "local" ? metadata.sourcePath : undefined;
  })();
  const candidates = [workspaceSkillPath, builtInSkillPath, metadataPath].filter((path): path is string => !!path);
  const rootPath = candidates.find((path) => existsSync(join(path, "SKILL.md")));

  if (!rootPath) {
    throw new Error("未找到 Skill 文件目录");
  }

  return {
    item,
    rootPath,
    files: buildFileTreeFromDir(rootPath)
  };
}

export function importLocalSkillDirectoryToWorkspace(
  input: ImportLocalSkillDirectoryToWorkspaceInput
): GlobalImportResult {
  const skillDirs = discoverSkillDirsFromLocalPath(input.localPath);
  const workspaceSkillsDir = getWorkspaceSkillsDir(input.workspaceSlug);

  for (const skill of skillDirs) {
    const targetDir = join(workspaceSkillsDir, skill.slug);
    if (!input.overwrite && existsSync(join(targetDir, "SKILL.md"))) {
      return {
        ok: true,
        imported: false,
        reason: `技能「${skill.slug}」已存在`
      };
    }
  }

  for (const skill of skillDirs) {
    const targetDir = join(workspaceSkillsDir, skill.slug);
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(skill.sourcePath, targetDir, { recursive: true });
  }

  saveLocalInstalledSkillMetadata({
    workspaceSlug: input.workspaceSlug,
    skills: skillDirs
  });

  return { ok: true, imported: true };
}

export function installSkillMarketItemToWorkspace(
  input: InstallSkillMarketItemToWorkspaceInput
): GlobalImportResult {
  const catalog = getSkillMarketCatalog({ workspaceSlug: input.workspaceSlug, includeBlockedSources: true });
  const item = catalog.items.find((candidate) => candidate.id === input.skillId || candidate.sourceId === input.skillId);
  if (!item) {
    throw new Error("未找到指定 Skill 来源");
  }

  const targetDir = join(getWorkspaceSkillsDir(input.workspaceSlug), item.slug);
  if (!input.overwrite && existsSync(join(targetDir, "SKILL.md"))) {
    return { ok: true, imported: false, reason: "工作区已存在同名 Skill" };
  }

  if (item.sourceType === "built-in") {
    const sourcePath = join(getDefaultSkillsDir(), item.slug);
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourcePath, targetDir, { recursive: true });
    return { ok: true, imported: true };
  }

  const metadata = getInstalledSkillSourceMetadata(input.workspaceSlug)[item.slug];
  if (metadata?.sourceType === "local") {
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(metadata.sourcePath, targetDir, { recursive: true });
    return { ok: true, imported: true };
  }

  throw new Error("该 Skill 来源暂不支持一键重新安装，请重新添加市场源");
}

export const __internal = {
  buildFileTreeFromDir,
  buildSkillMarketCatalog,
  discoverSkillDirsFromLocalPath,
  normalizeMetadataSkillSources,
  normalizeBuiltInSkills,
  readSkillsFromDir
};
