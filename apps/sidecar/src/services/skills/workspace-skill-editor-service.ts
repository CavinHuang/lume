import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type {
  EditableSkillDetailResult,
  EditableSkillMeta,
  GetEditableSkillInput,
  ListEditableSkillsInput,
  SaveWorkspaceSkillInput,
  SaveWorkspaceSkillResult,
  SkillSourceType,
  SkillStorageScope
} from "@lume/shared";
import YAML from "yaml";
import { getAliceUserSkillsDir, getDefaultSkillsDir, getUserSkillsDir, getWorkspaceSkillsDir } from "../infra/config-paths";
import { parseSkillFrontmatter } from "./skill-frontmatter";
import { getInstalledSkillSourceMetadata, type InstalledSkillSourceMeta } from "./skills-market-metadata";

const MAX_VERSIONS = 20;

function normalizeSkillSlug(skillSlug: string): string {
  const trimmed = skillSlug.trim();
  if (!trimmed) {
    throw new Error("Skill ID 不能为空");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === "." ||
    trimmed === ".." ||
    !/^[a-zA-Z0-9._-]+$/.test(trimmed)
  ) {
    throw new Error("非法 Skill 路径");
  }
  return trimmed;
}

function resolveWorkspaceSkillPath(workspaceSlug: string, skillSlug: string): string {
  return resolveSkillPath(getWorkspaceSkillsDir(workspaceSlug), skillSlug);
}

function resolveAliceUserSkillPath(skillSlug: string): string {
  return resolveSkillPath(getAliceUserSkillsDir(), skillSlug);
}

function resolveLegacyUserSkillPath(skillSlug: string): string {
  return resolveSkillPath(getUserSkillsDir(), skillSlug);
}

function resolveUserSkillPath(skillSlug: string): string {
  const alicePath = resolveAliceUserSkillPath(skillSlug);
  if (existsSync(alicePath)) return alicePath;

  const legacyPath = resolveLegacyUserSkillPath(skillSlug);
  return existsSync(legacyPath) ? legacyPath : alicePath;
}

function resolveAliceProjectSkillsDir(cwd: string | undefined): string {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    throw new Error("项目目录不能为空");
  }
  return join(resolve(trimmed), ".alice", "skills");
}

function resolveLegacyProjectSkillsDir(cwd: string | undefined): string {
  const trimmed = cwd?.trim();
  if (!trimmed) {
    throw new Error("项目目录不能为空");
  }
  return join(resolve(trimmed), ".lume", "skills");
}

function resolveProjectSkillPath(cwd: string | undefined, skillSlug: string): string {
  const alicePath = resolveSkillPath(resolveAliceProjectSkillsDir(cwd), skillSlug);
  if (existsSync(alicePath)) return alicePath;

  const legacyPath = resolveSkillPath(resolveLegacyProjectSkillsDir(cwd), skillSlug);
  return existsSync(legacyPath) ? legacyPath : alicePath;
}

function resolveSkillPath(rootDir: string, skillSlug: string): string {
  const skillsDir = resolve(rootDir);
  const skillDir = resolve(skillsDir, normalizeSkillSlug(skillSlug));
  const relativePath = relative(skillsDir, skillDir);

  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    relativePath.includes(`${sep}..`) ||
    resolve(relativePath) === relativePath
  ) {
    throw new Error("非法 Skill 路径");
  }

  return join(skillDir, "SKILL.md");
}

function resolveEditableSkillPath(input: {
  storageScope?: SkillStorageScope;
  workspaceSlug: string;
  cwd?: string;
}, skillSlug: string): string {
  if (input.storageScope === "user") {
    return resolveUserSkillPath(skillSlug);
  }
  if (input.storageScope === "project") {
    return resolveProjectSkillPath(input.cwd, skillSlug);
  }
  return resolveWorkspaceSkillPath(input.workspaceSlug, skillSlug);
}

function readBuiltInSkillSlugs(): Set<string> {
  const defaultSkillsDir = getDefaultSkillsDir();
  if (!existsSync(defaultSkillsDir)) return new Set();

  return new Set(
    readdirSync(defaultSkillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(defaultSkillsDir, entry.name, "SKILL.md")))
      .map((entry) => entry.name)
  );
}

function resolveSkillSourceType(input: {
  skillSlug: string;
  storageScope: SkillStorageScope;
  installedSources?: Record<string, InstalledSkillSourceMeta>;
  builtInSkillSlugs?: Set<string>;
}): SkillSourceType | undefined {
  if (input.storageScope !== "workspace") return undefined;
  const installedSource = input.installedSources?.[input.skillSlug];
  if (installedSource) return installedSource.sourceType;
  return input.builtInSkillSlugs?.has(input.skillSlug) ? "built-in" : undefined;
}

function getWorkspaceSkillSourceType(workspaceSlug: string, skillSlug: string): SkillSourceType | undefined {
  return resolveSkillSourceType({
    skillSlug,
    storageScope: "workspace",
    installedSources: getInstalledSkillSourceMetadata(workspaceSlug),
    builtInSkillSlugs: readBuiltInSkillSlugs()
  });
}

export function isMarketManagedWorkspaceSkill(workspaceSlug: string, skillSlug: string): boolean {
  return !!getWorkspaceSkillSourceType(workspaceSlug, skillSlug);
}

function assertSettingsManagedSkill(input: {
  storageScope?: SkillStorageScope;
  workspaceSlug: string;
}, skillSlug: string): void {
  if (input.storageScope && input.storageScope !== "workspace") return;
  if (!isMarketManagedWorkspaceSkill(input.workspaceSlug, skillSlug)) return;
  throw new Error("市场管理的 Skill 请在技能市场中管理");
}

function readEditableSkillsFromDir(
  rootDir: string,
  storageScope: SkillStorageScope,
  options: {
    installedSources?: Record<string, InstalledSkillSourceMeta>;
    builtInSkillSlugs?: Set<string>;
  } = {}
): EditableSkillMeta[] {
  if (!existsSync(rootDir)) return [];

  const skills: EditableSkillMeta[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(rootDir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const meta = parseSkillFrontmatter(readFileSync(skillPath, "utf-8"), entry.name);
    const sourceType = resolveSkillSourceType({
      skillSlug: entry.name,
      storageScope,
      installedSources: options.installedSources,
      builtInSkillSlugs: options.builtInSkillSlugs
    });
    skills.push({
      ...meta,
      storageScope,
      managementSurface: sourceType ? "market" : "settings",
      ...(sourceType ? { sourceType } : {})
    });
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function readUserEditableSkills(): EditableSkillMeta[] {
  const bySlug = new Map<string, EditableSkillMeta>();
  for (const skill of readEditableSkillsFromDir(getUserSkillsDir(), "user")) {
    bySlug.set(skill.slug, skill);
  }
  for (const skill of readEditableSkillsFromDir(getAliceUserSkillsDir(), "user")) {
    bySlug.set(skill.slug, skill);
  }
  return Array.from(bySlug.values()).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function readProjectEditableSkills(cwd: string): EditableSkillMeta[] {
  const bySlug = new Map<string, EditableSkillMeta>();
  for (const skill of readEditableSkillsFromDir(resolveLegacyProjectSkillsDir(cwd), "project")) {
    bySlug.set(skill.slug, skill);
  }
  for (const skill of readEditableSkillsFromDir(resolveAliceProjectSkillsDir(cwd), "project")) {
    bySlug.set(skill.slug, skill);
  }
  return Array.from(bySlug.values()).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function readPluginEditableSkills(): EditableSkillMeta[] {
  const pluginsRoot = join(homedir(), ".lume", "plugins");
  if (!existsSync(pluginsRoot)) return [];

  const bySlug = new Map<string, EditableSkillMeta>();
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pluginDir = join(pluginsRoot, entry.name);
    const skillsDir = join(pluginDir, "skills");
    if (!existsSync(skillsDir)) continue;

    for (const skill of readEditableSkillsFromDir(skillsDir, "plugin")) {
      // Namespace the slug with plugin name using ":" separator for explicit invocation
      const namespacedSlug = `${entry.name}:${skill.slug}`;
      bySlug.set(namespacedSlug, {
        ...skill,
        slug: namespacedSlug,
        name: `${entry.name}: ${skill.name}`,
        managementSurface: "plugin" as const,
        sourceType: "plugin" as const,
      });
    }
  }

  return Array.from(bySlug.values()).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAllowedTools(tools: string[] | undefined): string[] | undefined {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tool of tools ?? []) {
    const trimmed = tool.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function validateSkillInput(input: SaveWorkspaceSkillInput): void {
  if (!input.name.trim()) {
    throw new Error("技能 ID 和展示名称不能为空");
  }
  if (!trimOptional(input.description) || !trimOptional(input.whenToUse) || !input.prompt.trim()) {
    throw new Error("描述、触发条件和提示词内容不能为空");
  }
}

function buildSkillContent(input: SaveWorkspaceSkillInput, skillSlug: string): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name.trim() || skillSlug,
    disable_model_invocation: input.disableModelInvocation ?? false
  };
  const description = trimOptional(input.description);
  const whenToUse = trimOptional(input.whenToUse);
  const allowedTools = normalizeAllowedTools(input.allowedTools);
  const argumentHint = trimOptional(input.argumentHint);
  const version = trimOptional(input.version);

  if (description) frontmatter.description = description;
  if (whenToUse) frontmatter.when_to_use = whenToUse;
  if (allowedTools) frontmatter.allowed_tools = allowedTools;
  if (argumentHint) frontmatter.argument_hint = argumentHint;
  if (version) frontmatter.version = version;

  const yaml = YAML.stringify(frontmatter).trimEnd();
  const prompt = input.prompt.trimEnd();
  return `---\n${yaml}\n---\n\n${prompt}\n`;
}

function toVersionTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function isVersionFilename(filename: string): boolean {
  return /^SKILL_\d{8}_\d{6}_[a-f0-9-]+\.md$/i.test(filename)
    || /^\d{4}-\d{2}-\d{2}_\d{6}_[a-f0-9]{8}\.md$/i.test(filename);
}

async function pruneVersions(versionsDir: string): Promise<void> {
  const versions = (await readdir(versionsDir))
    .filter(isVersionFilename)
    .sort();

  for (const filename of versions.slice(0, Math.max(0, versions.length - MAX_VERSIONS))) {
    await unlink(join(versionsDir, filename)).catch(() => undefined);
  }
}

async function backupExistingSkill(skillPath: string): Promise<string | undefined> {
  if (!existsSync(skillPath)) return undefined;

  const versionsDir = join(dirname(skillPath), "versions");
  await mkdir(versionsDir, { recursive: true });
  const versionPath = join(versionsDir, `${toVersionTimestamp()}_${randomUUID().replace(/-/g, "").slice(0, 8)}.md`);
  await copyFile(skillPath, versionPath);
  await pruneVersions(versionsDir).catch(() => undefined);
  return versionPath;
}

async function writeSkillFileAtomically(skillPath: string, content: string): Promise<void> {
  const tempPath = `${skillPath}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, skillPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function saveWorkspaceSkill(input: SaveWorkspaceSkillInput): Promise<SaveWorkspaceSkillResult> {
  const skillSlug = normalizeSkillSlug(input.skillSlug);
  assertSettingsManagedSkill(input, skillSlug);
  validateSkillInput(input);
  const skillPath = resolveEditableSkillPath(input, skillSlug);
  await mkdir(dirname(skillPath), { recursive: true });

  const content = buildSkillContent(input, skillSlug);
  const versionPath = await backupExistingSkill(skillPath);
  await writeSkillFileAtomically(skillPath, content);

  return {
    ok: true,
    skill: parseSkillFrontmatter(content, skillSlug),
    ...(versionPath ? { versionPath } : {})
  };
}

export function listEditableSkills(input: ListEditableSkillsInput): EditableSkillMeta[] {
  const installedSources = getInstalledSkillSourceMetadata(input.workspaceSlug);
  const builtInSkillSlugs = readBuiltInSkillSlugs();

  const pluginSkills = readPluginEditableSkills();

  return [
    ...readUserEditableSkills(),
    ...(input.cwd ? readProjectEditableSkills(input.cwd) : []),
    ...readEditableSkillsFromDir(getWorkspaceSkillsDir(input.workspaceSlug), "workspace", {
      installedSources,
      builtInSkillSlugs
    }),
    ...pluginSkills
  ];
}

export function getEditableSkill(input: GetEditableSkillInput): EditableSkillDetailResult {
  const skillSlug = normalizeSkillSlug(input.skillSlug);
  assertSettingsManagedSkill(input, skillSlug);
  const skillPath = resolveEditableSkillPath(input, skillSlug);
  if (!existsSync(skillPath)) {
    throw new Error(`Skill 不存在: ${input.skillSlug}`);
  }

  const content = readFileSync(skillPath, "utf-8");
  return {
    skill: {
      ...parseSkillFrontmatter(content, skillSlug),
      storageScope: input.storageScope
    },
    content,
    path: skillPath
  };
}

export function deleteEditableSkill(input: GetEditableSkillInput): void {
  const skillSlug = normalizeSkillSlug(input.skillSlug);
  assertSettingsManagedSkill(input, skillSlug);
  const skillPath = resolveEditableSkillPath(input, skillSlug);
  if (!existsSync(skillPath)) {
    throw new Error(`Skill 不存在: ${input.skillSlug}`);
  }

  rmSync(dirname(skillPath), { recursive: true, force: true });
}

export const __internal = {
  buildSkillContent,
  normalizeAllowedTools,
  normalizeSkillSlug,
  writeSkillFileAtomically
};
