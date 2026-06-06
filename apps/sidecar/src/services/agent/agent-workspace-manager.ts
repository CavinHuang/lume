
import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentWorkspace,
  McpServerEntry,
  SkillMeta,
  WorkspaceCapabilities,
  WorkspaceMcpConfig
} from "@lume/shared";
import { normalizeMcpTransport } from "@lume/shared";
import {
  getAgentWorkspacePath,
  getAgentWorkspacesIndexPath,
  getDefaultSkillsDir,
  getUserSkillsDir,
  getWorkspaceMetaPath,
  getWorkspaceMcpPath,
  getWorkspaceResourcesPath,
  getWorkspaceSkillsDir
} from "../infra/config-paths";
import { seedDefaultSkills } from "../skills/default-skills-seeder";
import { ensureBootstrapFiles } from "../system/workspace-bootstrap-service";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { createLogger } from "../infra/logger";
import { parseSkillFrontmatter } from "../skills/skill-frontmatter";

interface AgentWorkspacesIndex {
  version: number;
  workspaces: AgentWorkspace[];
}

const INDEX_VERSION = 1;
const log = createLogger("agent-workspace-manager");

function writeJsonAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function backupCorruptIndex(indexPath: string, label: string): void {
  if (!existsSync(indexPath)) return;
  const backupPath = `${indexPath}.corrupt-${Date.now()}`;
  try {
    renameSync(indexPath, backupPath);
    console.warn(`[${label}] 检测到损坏索引，已备份: ${backupPath}`);
  } catch (error) {
    console.warn(`[${label}] 备份损坏索引失败:`, error);
  }
}

function readIndex(): AgentWorkspacesIndex {
  const indexPath = getAgentWorkspacesIndexPath();
  if (!existsSync(indexPath)) {
    return { version: INDEX_VERSION, workspaces: [] };
  }

  try {
    return JSON.parse(readFileSync(indexPath, "utf-8")) as AgentWorkspacesIndex;
  } catch (error) {
    console.error("[Agent 工作区] 读取索引文件失败:", error);
    backupCorruptIndex(indexPath, "Agent 工作区");
    return { version: INDEX_VERSION, workspaces: [] };
  }
}

function writeIndex(index: AgentWorkspacesIndex): void {
  const indexPath = getAgentWorkspacesIndexPath();
  try {
    writeJsonAtomic(indexPath, JSON.stringify(index, null, 2));
  } catch (error) {
    console.error("[Agent 工作区] 写入索引文件失败:", error);
    throw new Error("写入 Agent 工作区索引失败");
  }
}

function slugify(name: string, existingSlugs: Set<string>): string {
  let base = normalizeWorkspaceSlug(name);

  if (!base) {
    base = `workspace-${Date.now()}`;
  }

  let slug = base;
  let counter = 1;
  while (existingSlugs.has(slug)) {
    slug = `${base}-${counter}`;
    counter += 1;
  }

  return slug;
}

function normalizeWorkspaceSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeRequestedSlug(slug: string | undefined): string | undefined {
  if (slug === undefined) {
    return undefined;
  }

  const normalized = normalizeWorkspaceSlug(slug);
  return normalized || undefined;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

function readSkillVersion(skillDir: string): string {
  try {
    const content = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    const m = content.match(/^---\s*\n[\s\S]*?^version:\s*["']?([^"'\n]+)["']?/m);
    return m?.[1]?.trim() ?? "0";
  } catch {
    return "0";
  }
}

function copyDefaultSkills(workspaceSlug: string): void {
  seedDefaultSkills();
  const defaultDir = getDefaultSkillsDir();
  const targetDir = getWorkspaceSkillsDir(workspaceSlug);

  try {
    const entries = readdirSync(defaultDir, { withFileTypes: true });
    if (entries.length === 0) return;

    let copiedCount = 0;
    for (const entry of entries) {
      const source = join(defaultDir, entry.name);
      const target = join(targetDir, entry.name);
      if (existsSync(target)) {
        const sourceVersion = readSkillVersion(source);
        const targetVersion = readSkillVersion(target);
        if (compareVersions(sourceVersion, targetVersion) <= 0) continue;
      }
      cpSync(source, target, { recursive: true });
      copiedCount += 1;
    }
    if (copiedCount > 0) {
      log.info("default skills copied to workspace", { workspaceSlug, copiedCount });
    }
  } catch (error) {
    log.warn("default skills copy skipped", { workspaceSlug, error });
    // default-skills 不存在或复制失败时跳过
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseMcpServerEntry(value: unknown): McpServerEntry | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const enabled = value.enabled;
  const transport = normalizeMcpTransport(value);
  if (typeof enabled !== "boolean" || !transport) {
    return undefined;
  }
  if (transport === "stdio" && !isNonEmptyString(value.command)) {
    return undefined;
  }
  if ((transport === "streamable_http" || transport === "sse") && !isNonEmptyString(value.url)) {
    return undefined;
  }

  const entry: McpServerEntry = {
    enabled,
    transport
  };

  if (typeof value.command === "string") {
    entry.command = value.command;
  }
  const args = normalizeStringList(value.args);
  if (args.length > 0) {
    entry.args = args;
  }
  const disabledTools = normalizeStringList(value.disabledTools);
  if (disabledTools.length > 0) {
    entry.disabledTools = disabledTools;
  }
  if (isPlainObject(value.env)) {
    const env: Record<string, string> = {};
    for (const [key, envValue] of Object.entries(value.env)) {
      if (typeof envValue === "string") {
        env[key] = envValue;
      }
    }
    if (Object.keys(env).length > 0) {
      entry.env = env;
    }
  }
  if (typeof value.url === "string") {
    entry.url = value.url;
  }
  if (isPlainObject(value.headers)) {
    const headers: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(value.headers)) {
      if (typeof headerValue === "string") {
        headers[key] = headerValue;
      }
    }
    if (Object.keys(headers).length > 0) {
      entry.headers = headers;
    }
  }

  return entry;
}

function parseMcpConfigFromUnknown(value: unknown): WorkspaceMcpConfig {
  if (!isPlainObject(value) || !isPlainObject(value.servers)) {
    return { servers: {} };
  }
  const servers: WorkspaceMcpConfig["servers"] = {};
  for (const [name, entry] of Object.entries(value.servers)) {
    const parsedEntry = parseMcpServerEntry(entry);
    if (!parsedEntry) {
      continue;
    }
    servers[name] = parsedEntry;
  }
  return { servers };
}

function toCanonicalWorkspaceMcpConfig(config: WorkspaceMcpConfig): WorkspaceMcpConfig {
  return parseMcpConfigFromUnknown(config);
}

function getWorkspaceSkillOverrides(workspaceSlug: string): { enabled: Set<string>; disabled: Set<string> } {
  const effectiveConfig = getEffectiveLumeConfig(workspaceSlug);
  const skills = effectiveConfig.skills;
  if (!isPlainObject(skills)) {
    return { enabled: new Set<string>(), disabled: new Set<string>() };
  }
  return {
    enabled: new Set(normalizeStringList(skills.enabled)),
    disabled: new Set(normalizeStringList(skills.disabled))
  };
}

function shouldKeepSkill(
  skillSlug: string,
  overrides: { enabled: Set<string>; disabled: Set<string> }
): boolean {
  if (overrides.disabled.has(skillSlug)) {
    return false;
  }
  if (overrides.enabled.size > 0 && !overrides.enabled.has(skillSlug)) {
    return false;
  }
  return true;
}

export function ensureWorkspaceAgentAssets(workspaceSlug: string, workspaceName?: string): void {
  getWorkspaceResourcesPath(workspaceSlug);
  getWorkspaceMetaPath(workspaceSlug);
  copyDefaultSkills(workspaceSlug);
}

// 记录已初始化过的工作区，避免每次列表查询都触发文件系统操作
const initializedWorkspaceSlugs = new Set<string>();

export function listAgentWorkspaces(): AgentWorkspace[] {
  const workspaces = readIndex().workspaces;
  for (const workspace of workspaces) {
    if (!initializedWorkspaceSlugs.has(workspace.slug)) {
      ensureWorkspaceAgentAssets(workspace.slug, workspace.name);
      initializedWorkspaceSlugs.add(workspace.slug);
    }
  }
  return workspaces.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getAgentWorkspace(id: string): AgentWorkspace | undefined {
  return readIndex().workspaces.find((workspace) => workspace.id === id);
}

export function getAgentWorkspaceBySlug(slug: string): AgentWorkspace | undefined {
  return readIndex().workspaces.find((workspace) => workspace.slug === slug);
}

export function createAgentWorkspace(name: string, options?: { slug?: string }): AgentWorkspace {
  const index = readIndex();
  const existingSlugs = new Set(index.workspaces.map((workspace) => workspace.slug));
  const explicitSlug = normalizeRequestedSlug(options?.slug);

  if (explicitSlug && existingSlugs.has(explicitSlug)) {
    throw new Error("workspace slug 已存在");
  }

  const slug = explicitSlug || slugify(name, existingSlugs);
  const now = Date.now();

  const workspace: AgentWorkspace = {
    id: randomUUID(),
    name,
    slug,
    createdAt: now,
    updatedAt: now
  };

  getAgentWorkspacePath(slug);
  ensureWorkspaceAgentAssets(slug, name);

  // 创建 Bootstrap 文件
  ensureBootstrapFiles(slug);

  index.workspaces.push(workspace);
  writeIndex(index);

  console.log(`[Agent 工作区] 已创建工作区: ${name} (slug: ${slug})`);
  return workspace;
}

export function updateAgentWorkspace(id: string, updates: { name: string }): AgentWorkspace {
  const index = readIndex();
  const idx = index.workspaces.findIndex((workspace) => workspace.id === id);
  if (idx === -1) {
    throw new Error(`Agent 工作区不存在: ${id}`);
  }

  const existing = index.workspaces[idx] as AgentWorkspace;
  const updated: AgentWorkspace = {
    ...existing,
    name: updates.name,
    updatedAt: Date.now()
  };

  index.workspaces[idx] = updated;
  writeIndex(index);

  console.log(`[Agent 工作区] 已更新工作区: ${updated.name} (${updated.id})`);
  return updated;
}

export function deleteAgentWorkspace(id: string): void {
  const index = readIndex();
  const idx = index.workspaces.findIndex((workspace) => workspace.id === id);
  if (idx === -1) {
    throw new Error(`Agent 工作区不存在: ${id}`);
  }

  const removed = index.workspaces.splice(idx, 1)[0] as AgentWorkspace;
  writeIndex(index);

  console.log(`[Agent 工作区] 已删除工作区索引: ${removed.name} (slug: ${removed.slug}，目录已保留)`);
}

export function ensureDefaultWorkspace(): AgentWorkspace {
  const index = readIndex();
  const existing = index.workspaces.find((workspace) => workspace.slug === "default");

  if (existing) {
    ensureWorkspaceAgentAssets(existing.slug, existing.name);
    // 确保 Bootstrap 文件存在（幂等操作）
    ensureBootstrapFiles(existing.slug);
    return existing;
  }

  const now = Date.now();
  const workspace: AgentWorkspace = {
    id: randomUUID(),
    name: "默认工作区",
    slug: "default",
    createdAt: now,
    updatedAt: now
  };

  getAgentWorkspacePath("default");
  ensureWorkspaceAgentAssets("default", "默认工作区");

  // 创建 Bootstrap 文件
  ensureBootstrapFiles("default");

  index.workspaces.push(workspace);
  writeIndex(index);

  console.log("[Agent 工作区] 已创建默认工作区");
  return workspace;
}

export function getWorkspaceMcpConfig(workspaceSlug: string): WorkspaceMcpConfig {
  const mcpPath = getWorkspaceMcpPath(workspaceSlug);
  let workspaceConfig: WorkspaceMcpConfig = { servers: {} };
  if (!existsSync(mcpPath)) {
    workspaceConfig = { servers: {} };
  } else {
    try {
      workspaceConfig = parseMcpConfigFromUnknown(JSON.parse(readFileSync(mcpPath, "utf-8")));
    } catch (error) {
      console.error("[Agent 工作区] 读取 MCP 配置失败:", error);
      workspaceConfig = { servers: {} };
    }
  }

  const effectiveConfig = getEffectiveLumeConfig(workspaceSlug);
  const lumeConfig = parseMcpConfigFromUnknown(effectiveConfig.mcp);

  return {
    servers: {
      ...workspaceConfig.servers,
      ...lumeConfig.servers
    }
  };
}

export function saveWorkspaceMcpConfig(workspaceSlug: string, config: WorkspaceMcpConfig): void {
  const mcpPath = getWorkspaceMcpPath(workspaceSlug);
  try {
    writeJsonAtomic(mcpPath, JSON.stringify(toCanonicalWorkspaceMcpConfig(config), null, 2));
    console.log(`[Agent 工作区] 已保存 MCP 配置: ${workspaceSlug}`);
  } catch (error) {
    console.error("[Agent 工作区] 保存 MCP 配置失败:", error);
    throw new Error("保存 MCP 配置失败");
  }
}

export function getWorkspaceSkills(workspaceSlug: string): SkillMeta[] {
  const skillsDir = getWorkspaceSkillsDir(workspaceSlug);
  const skillOverrides = getWorkspaceSkillOverrides(workspaceSlug);
  return readSkillsFromDir(skillsDir, {
    workspaceSlug,
    shouldKeep: (skillSlug) => shouldKeepSkill(skillSlug, skillOverrides)
  });
}

export function getRuntimeSkills(workspaceSlug: string, cwd?: string): SkillMeta[] {
  const roots = [
    getUserSkillsDir(),
    ...(cwd ? [join(cwd, ".lume", "skills")] : []),
    getWorkspaceSkillsDir(workspaceSlug)
  ];
  const workspaceSkillOverrides = getWorkspaceSkillOverrides(workspaceSlug);
  const bySlug = new Map<string, SkillMeta>();

  for (const root of roots) {
    const isWorkspaceRoot = root === getWorkspaceSkillsDir(workspaceSlug);
    for (const skill of readSkillsFromDir(root, {
      workspaceSlug,
      shouldKeep: isWorkspaceRoot
        ? (skillSlug) => shouldKeepSkill(skillSlug, workspaceSkillOverrides)
        : undefined
    })) {
      bySlug.set(skill.slug, skill);
    }
  }

  return sortSkills(Array.from(bySlug.values()));
}

function readSkillsFromDir(
  skillsDir: string,
  options: {
    workspaceSlug?: string;
    shouldKeep?: (skillSlug: string) => boolean;
  } = {}
): SkillMeta[] {
  const skills: SkillMeta[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (options.shouldKeep && !options.shouldKeep(entry.name)) continue;

      const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      try {
        const content = readFileSync(skillMdPath, "utf-8");
        skills.push(parseSkillFrontmatter(content, entry.name));
      } catch (error) {
        log.warn("skill parse failed", { workspaceSlug: options.workspaceSlug, skillsDir, skillSlug: entry.name, error });
      }
    }
  } catch {
    // skills 目录不存在时返回空数组
  }

  return sortSkills(skills);
}

function sortSkills(skills: SkillMeta[]): SkillMeta[] {
  return skills.sort((left, right) => {
    const byName = left.name.localeCompare(right.name, "zh-CN");
    return byName || left.slug.localeCompare(right.slug, "zh-CN");
  });
}

export function getWorkspaceCapabilities(workspaceSlug: string): WorkspaceCapabilities {
  const mcpConfig = getWorkspaceMcpConfig(workspaceSlug);
  const skills = getWorkspaceSkills(workspaceSlug);

  const mcpServers = Object.entries(mcpConfig.servers).flatMap(([name, entry]) => {
    const transport = normalizeMcpTransport(entry);
    if (!transport) {
      return [];
    }
    return [{
      name,
      enabled: entry.enabled,
      type: transport
    }];
  });

  return { mcpServers, skills };
}

export function deleteWorkspaceSkill(workspaceSlug: string, skillSlug: string): void {
  const skillsDir = getWorkspaceSkillsDir(workspaceSlug);
  const skillPath = join(skillsDir, skillSlug);
  if (!existsSync(skillPath)) {
    throw new Error(`Skill 不存在: ${skillSlug}`);
  }

  rmSync(skillPath, { recursive: true, force: true });
  log.info("workspace skill deleted", { workspaceSlug, skillSlug });
}
