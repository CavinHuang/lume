
import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type {
  AgentWorkspace,
  AgentWorkspaceStatus,
  McpServerEntry,
  SkillMeta,
  WorkspaceCapabilities,
  WorkspaceMcpConfig
} from "@lume/shared";
import { normalizeMcpTransport } from "@lume/shared";
import {
  getAgentWorkspacePath,
  getAgentWorkspacesIndexPath,
  getAliceUserSkillsDir,
  getDefaultSkillsDir,
  getUserSkillsDir,
  getWorkspaceMetaPath,
  getWorkspaceMcpPath,
  getWorkspaceSkillsDir
} from "../infra/config-paths";
import { backupCorruptFile } from "../infra/corrupt-file-backup";
import { withIndexMutationLock } from "../infra/index-mutation-lock";
import { REMOVED_BUNDLE_SKILLS, seedDefaultSkills } from "../skills/default-skills-seeder";
import { normalizeRealpathKey } from "./agent-workdir-resolver";
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

function getWorkspaceStatusForRecord(workspace: AgentWorkspace): AgentWorkspaceStatus {
  if (!workspace.projectPath?.trim()) {
    return {
      workspaceId: workspace.id,
      availability: "unbound",
      message: "项目尚未绑定本地目录"
    };
  }
  try {
    const resolved = assertExistingDirectory(workspace.projectPath);
    return {
      workspaceId: workspace.id,
      availability: "available",
      projectPath: workspace.projectPath,
      realpath: realpathSync(resolved)
    };
  } catch (error) {
    return {
      workspaceId: workspace.id,
      availability: "unavailable",
      projectPath: workspace.projectPath,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function assertExistingDirectory(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`项目目录不存在: ${resolved}`);
  }
  if (!readDirectoryStat(resolved)) {
    throw new Error(`项目目录不是目录: ${resolved}`);
  }
  return resolved;
}

function readDirectoryStat(path: string): boolean {
  try {
    return existsSync(path) && readdirSync(path, { withFileTypes: true }) !== undefined;
  } catch {
    return false;
  }
}

function writeJsonAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function backupCorruptIndex(indexPath: string, label: string): void {
  const backupPath = backupCorruptFile(indexPath);
  if (backupPath) log.warn("backed up corrupt workspace index", { label, backupPath });
}

function readIndex(): AgentWorkspacesIndex {
  const indexPath = getAgentWorkspacesIndexPath();
  if (!existsSync(indexPath)) {
    return { version: INDEX_VERSION, workspaces: [] };
  }

  try {
    return JSON.parse(readFileSync(indexPath, "utf-8")) as AgentWorkspacesIndex;
  } catch (error) {
    log.error("failed to read workspace index", { error, indexPath });
    backupCorruptIndex(indexPath, "Agent 工作区");
    return { version: INDEX_VERSION, workspaces: [] };
  }
}

function writeIndex(index: AgentWorkspacesIndex): void {
  const indexPath = getAgentWorkspacesIndexPath();
  try {
    writeJsonAtomic(indexPath, JSON.stringify(index, null, 2));
  } catch (error) {
    log.error("failed to write workspace index", { error, indexPath });
    throw new Error("写入 Agent 工作区索引失败");
  }
}

function workspaceIndexLockPath(): string {
  return `${getAgentWorkspacesIndexPath()}.lock`;
}

function withWorkspaceIndexMutation<T>(fn: (index: AgentWorkspacesIndex) => T): T {
  return withIndexMutationLock(workspaceIndexLockPath(), () => fn(readIndex()));
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
    pruneRemovedBundleSkills(targetDir);
  } catch (error) {
    log.warn("default skills copy skipped", { workspaceSlug, error });
    // default-skills 不存在或复制失败时跳过
  }
}

function pruneRemovedBundleSkills(targetDir: string): void {
  for (const slug of REMOVED_BUNDLE_SKILLS) {
    const target = join(targetDir, slug);
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    log.info("removed bundle skill pruned from workspace", { skillSlug: slug });
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

export function getAgentWorkspaceStatus(id: string): AgentWorkspaceStatus {
  const workspace = getAgentWorkspace(id);
  if (!workspace) {
    throw new Error(`Agent 工作区不存在: ${id}`);
  }
  return getWorkspaceStatusForRecord(workspace);
}

export function createAgentWorkspace(name: string, options?: { slug?: string; projectPath?: string }): AgentWorkspace {
  return withWorkspaceIndexMutation((index) => {
    const projectPath = options?.projectPath?.trim();
    let resolvedProjectPath: string | undefined;
    let realpathKey: string | undefined;
    if (projectPath) {
      resolvedProjectPath = assertExistingDirectory(projectPath);
      realpathKey = normalizeRealpathKey(resolvedProjectPath);
      const existing = index.workspaces.find((workspace) => workspace.realpathKey === realpathKey);
      if (existing) {
        return existing;
      }
    }

    const existingSlugs = new Set(index.workspaces.map((workspace) => workspace.slug));
    const explicitSlug = normalizeRequestedSlug(options?.slug);

    if (explicitSlug && existingSlugs.has(explicitSlug)) {
      throw new Error("workspace slug 已存在");
    }

    const displayName = resolvedProjectPath ? basename(resolvedProjectPath) || name : name;
    const slug = explicitSlug || slugify(displayName, existingSlugs);
    const now = Date.now();

    const workspace: AgentWorkspace = {
      id: randomUUID(),
      name: displayName,
      slug,
      ...(resolvedProjectPath ? { projectPath: resolvedProjectPath } : {}),
      ...(realpathKey ? { realpathKey } : {}),
      createdAt: now,
      updatedAt: now
    };

    getAgentWorkspacePath(slug);
    ensureWorkspaceAgentAssets(slug, displayName);

    // 创建 Bootstrap 文件
    ensureBootstrapFiles(slug);

    index.workspaces.push(workspace);
    writeIndex(index);

    log.info("created agent workspace", { workspaceId: workspace.id, slug });
    return workspace;
  });
}

export function updateAgentWorkspace(id: string, updates: { name: string }): AgentWorkspace {
  return withWorkspaceIndexMutation((index) => {
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

    log.info("updated agent workspace", { workspaceId: updated.id, slug: updated.slug });
    return updated;
  });
}

export function bindLegacyAgentWorkspace(id: string, projectPath: string): AgentWorkspace {
  return withWorkspaceIndexMutation((index) => {
    const idx = index.workspaces.findIndex((workspace) => workspace.id === id);
    if (idx === -1) {
      throw new Error(`Agent 工作区不存在: ${id}`);
    }
    const existing = index.workspaces[idx] as AgentWorkspace;
    if (existing.projectPath?.trim()) {
      throw new Error("项目已绑定本地目录，不能执行首次绑定");
    }

    const resolvedProjectPath = assertExistingDirectory(projectPath);
    const realpathKey = normalizeRealpathKey(resolvedProjectPath);
    const duplicate = index.workspaces.find((workspace) =>
      workspace.id !== id && workspace.realpathKey === realpathKey
    );
    if (duplicate) {
      throw new Error(`该目录已绑定到项目: ${duplicate.name}`);
    }

    const updated: AgentWorkspace = {
      ...existing,
      projectPath: resolvedProjectPath,
      realpathKey,
      updatedAt: Date.now()
    };
    index.workspaces[idx] = updated;
    writeIndex(index);
    initializedWorkspaceSlugs.delete(updated.slug);
    return updated;
  });
}

export function relocateUnavailableAgentWorkspace(id: string, projectPath: string): AgentWorkspace {
  return withWorkspaceIndexMutation((index) => {
    const idx = index.workspaces.findIndex((workspace) => workspace.id === id);
    if (idx === -1) {
      throw new Error(`Agent 工作区不存在: ${id}`);
    }
    const existing = index.workspaces[idx] as AgentWorkspace;
    if (!existing.projectPath?.trim()) {
      throw new Error("项目尚未绑定本地目录，请先执行首次绑定");
    }
    if (getWorkspaceStatusForRecord(existing).availability === "available") {
      throw new Error("项目目录仍可访问，不能迁移到其他目录");
    }

    const resolvedProjectPath = assertExistingDirectory(projectPath);
    const realpathKey = normalizeRealpathKey(resolvedProjectPath);
    const duplicate = index.workspaces.find((workspace) =>
      workspace.id !== id && workspace.realpathKey === realpathKey
    );
    if (duplicate) {
      throw new Error(`该目录已绑定到项目: ${duplicate.name}`);
    }

    const updated: AgentWorkspace = {
      ...existing,
      projectPath: resolvedProjectPath,
      realpathKey,
      updatedAt: Date.now()
    };
    index.workspaces[idx] = updated;
    writeIndex(index);
    initializedWorkspaceSlugs.delete(updated.slug);
    return updated;
  });
}

export function deleteAgentWorkspace(id: string): void {
  withWorkspaceIndexMutation((index) => {
    const idx = index.workspaces.findIndex((workspace) => workspace.id === id);
    if (idx === -1) {
      throw new Error(`Agent 工作区不存在: ${id}`);
    }

    const removed = index.workspaces.splice(idx, 1)[0] as AgentWorkspace;
    writeIndex(index);

    log.info("removed agent workspace index while preserving project directory", { workspaceId: removed.id, slug: removed.slug });
  });
}

export function deleteAgentWorkspaceInternalData(slug: string): void {
  const workspaceDir = getAgentWorkspacePath(slug);
  rmSync(workspaceDir, { recursive: true, force: true });
}

export function ensureDefaultWorkspace(): AgentWorkspace {
  const index = readIndex();
  const existing = index.workspaces.find((workspace) => workspace.slug === "default");
  if (!existing) {
    throw new Error("默认工作区已停用；请选择项目目录或创建普通会话");
  }
  ensureWorkspaceAgentAssets(existing.slug, existing.name);
  ensureBootstrapFiles(existing.slug);
  return existing;
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
      log.error("failed to read workspace MCP configuration", { error, workspaceSlug });
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
    log.info("saved workspace MCP configuration", { workspaceSlug });
  } catch (error) {
    log.error("failed to save workspace MCP configuration", { error, workspaceSlug });
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
    getAliceUserSkillsDir(),
    ...(cwd ? [join(cwd, ".lume", "skills"), join(cwd, ".alice", "skills")] : []),
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
