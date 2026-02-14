/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-workspace-manager.ts
 * Adaptation:
 * - Shared imports updated to `@lume/shared`.
 * - Config root and paths are resolved by sidecar `config-paths` (`~/.lume`).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentWorkspace,
  SkillMeta,
  WorkspaceCapabilities,
  WorkspaceMcpConfig
} from "@lume/shared";
import {
  getAgentWorkspacePath,
  getAgentWorkspacesIndexPath,
  getDefaultSkillsDir,
  getWorkspaceMcpPath,
  getWorkspaceSkillsDir
} from "./config-paths";
import { seedDefaultSkills } from "./default-skills-seeder";
import { ensureBootstrapFiles } from "./workspace-bootstrap-service";

interface AgentWorkspacesIndex {
  version: number;
  workspaces: AgentWorkspace[];
}

const INDEX_VERSION = 1;

function readIndex(): AgentWorkspacesIndex {
  const indexPath = getAgentWorkspacesIndexPath();
  if (!existsSync(indexPath)) {
    return { version: INDEX_VERSION, workspaces: [] };
  }

  try {
    return JSON.parse(readFileSync(indexPath, "utf-8")) as AgentWorkspacesIndex;
  } catch (error) {
    console.error("[Agent 工作区] 读取索引文件失败:", error);
    return { version: INDEX_VERSION, workspaces: [] };
  }
}

function writeIndex(index: AgentWorkspacesIndex): void {
  const indexPath = getAgentWorkspacesIndexPath();
  try {
    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
  } catch (error) {
    console.error("[Agent 工作区] 写入索引文件失败:", error);
    throw new Error("写入 Agent 工作区索引失败");
  }
}

function slugify(name: string, existingSlugs: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

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

function copyDefaultSkills(workspaceSlug: string): void {
  // Ensure ~/.lume/default-skills has been populated from bundled defaults.
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
      if (existsSync(target)) continue;
      cpSync(source, target, { recursive: true });
      copiedCount += 1;
    }
    if (copiedCount > 0) {
      console.log(`[Agent 工作区] 已补齐默认 Skills (${copiedCount}) 到: ${workspaceSlug}`);
    }
  } catch {
    // default-skills 不存在或复制失败时跳过
  }
}

export function ensureWorkspaceAgentAssets(workspaceSlug: string, workspaceName?: string): void {
  if (workspaceName) {
    ensurePluginManifest(workspaceSlug, workspaceName);
  }
  copyDefaultSkills(workspaceSlug);
}

export function listAgentWorkspaces(): AgentWorkspace[] {
  const workspaces = readIndex().workspaces;
  for (const workspace of workspaces) {
    ensureWorkspaceAgentAssets(workspace.slug, workspace.name);
  }
  return workspaces.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getAgentWorkspace(id: string): AgentWorkspace | undefined {
  return readIndex().workspaces.find((workspace) => workspace.id === id);
}

export function getAgentWorkspaceBySlug(slug: string): AgentWorkspace | undefined {
  return readIndex().workspaces.find((workspace) => workspace.slug === slug);
}

export function createAgentWorkspace(name: string): AgentWorkspace {
  const index = readIndex();
  const existingSlugs = new Set(index.workspaces.map((workspace) => workspace.slug));
  const slug = slugify(name, existingSlugs);
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

export function ensurePluginManifest(workspaceSlug: string, workspaceName: string): void {
  const workspacePath = getAgentWorkspacePath(workspaceSlug);
  const pluginDir = join(workspacePath, ".claude-plugin");
  const manifestPath = join(pluginDir, "plugin.json");

  if (existsSync(manifestPath)) return;

  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }

  const manifest = {
    name: `lume-workspace-${workspaceSlug}`,
    version: "1.0.0",
    displayName: workspaceName
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`[Agent 工作区] 已创建 plugin manifest: ${workspaceSlug}`);
}

export function getWorkspaceMcpConfig(workspaceSlug: string): WorkspaceMcpConfig {
  const mcpPath = getWorkspaceMcpPath(workspaceSlug);
  if (!existsSync(mcpPath)) {
    return { servers: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8")) as Partial<WorkspaceMcpConfig>;
    return { servers: parsed.servers ?? {} };
  } catch (error) {
    console.error("[Agent 工作区] 读取 MCP 配置失败:", error);
    return { servers: {} };
  }
}

export function saveWorkspaceMcpConfig(workspaceSlug: string, config: WorkspaceMcpConfig): void {
  const mcpPath = getWorkspaceMcpPath(workspaceSlug);
  try {
    writeFileSync(mcpPath, JSON.stringify(config, null, 2), "utf-8");
    console.log(`[Agent 工作区] 已保存 MCP 配置: ${workspaceSlug}`);
  } catch (error) {
    console.error("[Agent 工作区] 保存 MCP 配置失败:", error);
    throw new Error("保存 MCP 配置失败");
  }
}

export function getWorkspaceSkills(workspaceSlug: string): SkillMeta[] {
  const skillsDir = getWorkspaceSkillsDir(workspaceSlug);
  const skills: SkillMeta[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      try {
        const content = readFileSync(skillMdPath, "utf-8");
        skills.push(parseSkillFrontmatter(content, entry.name));
      } catch {
        console.warn(`[Agent 工作区] 解析 Skill 失败: ${entry.name}`);
      }
    }
  } catch {
    // skills 目录不存在时返回空数组
  }

  return skills;
}

function parseSkillFrontmatter(content: string, slug: string): SkillMeta {
  const meta: SkillMeta = { slug, name: slug };
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return meta;
  }

  const frontmatter = frontmatterMatch[1] as string;
  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "");

    if (key === "name" && value) meta.name = value;
    if (key === "description" && value) meta.description = value;
    if (key === "icon" && value) meta.icon = value;
  }

  return meta;
}

export function getWorkspaceCapabilities(workspaceSlug: string): WorkspaceCapabilities {
  const mcpConfig = getWorkspaceMcpConfig(workspaceSlug);
  const skills = getWorkspaceSkills(workspaceSlug);

  const mcpServers = Object.entries(mcpConfig.servers).map(([name, entry]) => ({
    name,
    enabled: entry.enabled,
    type: entry.type
  }));

  return { mcpServers, skills };
}

export function deleteWorkspaceSkill(workspaceSlug: string, skillSlug: string): void {
  const skillsDir = getWorkspaceSkillsDir(workspaceSlug);
  const skillPath = join(skillsDir, skillSlug);
  if (!existsSync(skillPath)) {
    throw new Error(`Skill 不存在: ${skillSlug}`);
  }

  rmSync(skillPath, { recursive: true, force: true });
  console.log(`[Agent 工作区] 已删除 Skill: ${workspaceSlug}/${skillSlug}`);
}
