/**
 * Global discovery service
 *
 * Discover Claude global MCP / plugin marketplaces / plugins / skills,
 * and provide import helpers to workspace-scoped config.
 */

import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import type {
  GlobalMarketplacePluginMeta,
  GlobalPluginMarketplaceDetail,
  InstallGlobalPluginInput,
  InstallGlobalPluginResult,
  GlobalDiscoverySnapshot,
  GlobalDiscoveryWarning,
  GlobalImportResult,
  GlobalMcpServerMeta,
  GlobalSkillMeta,
  ImportGlobalMcpToWorkspaceInput,
  ImportGlobalSkillToWorkspaceInput,
  McpServerEntry,
  McpTransportType
} from "@lume/shared";
import {
  getWorkspaceSkillsDir
} from "./config-paths";
import {
  getWorkspaceMcpConfig,
  saveWorkspaceMcpConfig
} from "./agent-workspace-manager";

const GLOBAL_DISCOVERY_VERSION = 1;
const CLAUDE_PROVIDER = "claude" as const;

const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");
const CLAUDE_ROOT = join(homedir(), ".claude");
const CLAUDE_SKILLS_DIR = join(CLAUDE_ROOT, "skills");
const CLAUDE_PLUGINS_DIR = join(CLAUDE_ROOT, "plugins");
const CLAUDE_KNOWN_MARKETPLACES_PATH = join(CLAUDE_PLUGINS_DIR, "known_marketplaces.json");
const CLAUDE_INSTALLED_PLUGINS_PATH = join(CLAUDE_PLUGINS_DIR, "installed_plugins.json");

function pushWarning(
  warnings: GlobalDiscoveryWarning[],
  code: string,
  message: string,
  details?: string
): void {
  warnings.push({ code, message, details });
}

function readJsonFile(path: string, warnings: GlobalDiscoveryWarning[], warnCode: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    pushWarning(
      warnings,
      warnCode,
      `解析 JSON 失败: ${path}`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asStringMap(value: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  const record = asRecord(value);
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string") {
      output[key] = raw;
    }
  }
  return output;
}

function pickMcpType(entry: Record<string, unknown>): McpTransportType {
  const type = entry.type;
  if (type === "stdio" || type === "http" || type === "sse") return type;
  if (typeof entry.url === "string") return "http";
  return "stdio";
}

function normalizeGlobalMcpEntry(name: string, entry: Record<string, unknown>): GlobalMcpServerMeta {
  const type = pickMcpType(entry);
  const enabled = entry.enabled !== false && entry.disabled !== true;
  const normalized: GlobalMcpServerMeta = {
    id: `claude:mcp:${name}`,
    provider: CLAUDE_PROVIDER,
    name,
    type,
    enabled,
    sourcePath: CLAUDE_JSON_PATH
  };

  if (type === "stdio") {
    const command = typeof entry.command === "string" ? entry.command : undefined;
    const args = asStringArray(entry.args);
    const env = asStringMap(entry.env);
    return {
      ...normalized,
      ...(command ? { command } : {}),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {})
    };
  }

  const url = typeof entry.url === "string" ? entry.url : undefined;
  const headers = asStringMap(entry.headers);
  return {
    ...normalized,
    ...(url ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {})
  };
}

function parseSkillFrontmatter(content: string, slug: string): Pick<GlobalSkillMeta, "name" | "description" | "icon"> {
  const meta: Pick<GlobalSkillMeta, "name" | "description" | "icon"> = { name: slug };
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return meta;

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

function parseClaudeGlobalMcp(warnings: GlobalDiscoveryWarning[]): GlobalMcpServerMeta[] {
  const payload = readJsonFile(CLAUDE_JSON_PATH, warnings, "CLAUDE_MCP_JSON_PARSE_FAILED");
  const root = asRecord(payload);
  const rawMcpServers = asRecord(root.mcpServers);
  const servers: GlobalMcpServerMeta[] = [];
  for (const [name, raw] of Object.entries(rawMcpServers)) {
    const entry = asRecord(raw);
    if (Object.keys(entry).length === 0) continue;
    servers.push(normalizeGlobalMcpEntry(name, entry));
  }
  return servers;
}

function parseClaudeGlobalPluginMarketplaces(
  warnings: GlobalDiscoveryWarning[]
): GlobalDiscoverySnapshot["pluginMarketplaces"] {
  const payload = readJsonFile(
    CLAUDE_KNOWN_MARKETPLACES_PATH,
    warnings,
    "CLAUDE_MARKETPLACES_JSON_PARSE_FAILED"
  );
  const root = asRecord(payload);
  const marketplaces: GlobalDiscoverySnapshot["pluginMarketplaces"] = [];

  for (const [id, raw] of Object.entries(root)) {
    const record = asRecord(raw);
    const source = asRecord(record.source);
    const sourceType = source.source;
    const installLocation = typeof record.installLocation === "string" ? record.installLocation : "";
    const sourceRef = sourceType === "github"
      ? String(source.repo ?? "")
      : sourceType === "directory"
        ? String(source.path ?? "")
        : "";
    marketplaces.push({
      id,
      provider: CLAUDE_PROVIDER,
      sourceType: sourceType === "github" || sourceType === "directory" ? sourceType : "unknown",
      sourceRef,
      installLocation,
      ...(typeof record.lastUpdated === "string" ? { lastUpdated: record.lastUpdated } : {}),
      ...(typeof record.autoUpdate === "boolean" ? { autoUpdate: record.autoUpdate } : {})
    });
  }

  return marketplaces;
}

function parseMarketplacePluginsFromInstallLocation(
  installLocation: string,
  warnings: GlobalDiscoveryWarning[]
): GlobalMarketplacePluginMeta[] {
  const manifestPath = join(installLocation, ".claude-plugin", "marketplace.json");
  if (!existsSync(manifestPath)) return [];
  const payload = readJsonFile(manifestPath, warnings, "CLAUDE_MARKETPLACE_MANIFEST_PARSE_FAILED");
  const root = asRecord(payload);
  const rawPlugins = Array.isArray(root.plugins) ? root.plugins : [];
  const plugins: GlobalMarketplacePluginMeta[] = [];
  for (const item of rawPlugins) {
    const plugin = asRecord(item);
    const name = typeof plugin.name === "string" ? plugin.name.trim() : "";
    if (!name) continue;
    const author = asRecord(plugin.author);
    plugins.push({
      name,
      ...(typeof plugin.description === "string" ? { description: plugin.description } : {}),
      ...(typeof plugin.version === "string" ? { version: plugin.version } : {}),
      ...(typeof plugin.source === "string" ? { source: plugin.source } : {}),
      ...(typeof plugin.homepage === "string" ? { homepage: plugin.homepage } : {}),
      ...(typeof author.name === "string" ? { authorName: author.name } : {})
    });
  }
  return plugins;
}

function parseClaudeGlobalPlugins(warnings: GlobalDiscoveryWarning[]): GlobalDiscoverySnapshot["plugins"] {
  const payload = readJsonFile(
    CLAUDE_INSTALLED_PLUGINS_PATH,
    warnings,
    "CLAUDE_INSTALLED_PLUGINS_JSON_PARSE_FAILED"
  );
  const root = asRecord(payload);
  const rawPlugins = asRecord(root.plugins);
  const plugins: GlobalDiscoverySnapshot["plugins"] = [];

  for (const [key, rawInstallations] of Object.entries(rawPlugins)) {
    const splitAt = key.lastIndexOf("@");
    if (splitAt <= 0) {
      pushWarning(warnings, "CLAUDE_PLUGIN_KEY_INVALID", `插件 key 格式非法: ${key}`);
      continue;
    }

    const pluginName = key.slice(0, splitAt);
    const marketplaceId = key.slice(splitAt + 1);
    const installations = Array.isArray(rawInstallations) ? rawInstallations : [];
    const scopes = new Set<string>();
    const versions = new Set<string>();
    const projectPaths = new Set<string>();
    let lastUpdated: string | undefined;

    for (const item of installations) {
      const install = asRecord(item);
      if (typeof install.scope === "string") scopes.add(install.scope);
      if (typeof install.version === "string") versions.add(install.version);
      if (typeof install.projectPath === "string") projectPaths.add(install.projectPath);
      if (typeof install.lastUpdated === "string") {
        if (!lastUpdated || install.lastUpdated > lastUpdated) {
          lastUpdated = install.lastUpdated;
        }
      }
    }

    plugins.push({
      id: `claude:plugin:${key}`,
      provider: CLAUDE_PROVIDER,
      pluginName,
      marketplaceId,
      installCount: installations.length,
      scopes: [...scopes],
      versions: [...versions],
      projectPaths: [...projectPaths],
      ...(lastUpdated ? { lastUpdated } : {})
    });
  }

  return plugins;
}

function parseClaudeGlobalSkills(warnings: GlobalDiscoveryWarning[]): GlobalSkillMeta[] {
  if (!existsSync(CLAUDE_SKILLS_DIR)) return [];
  const skills: GlobalSkillMeta[] = [];
  try {
    const entries = readdirSync(CLAUDE_SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(CLAUDE_SKILLS_DIR, entry.name);
      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      try {
        const content = readFileSync(skillMdPath, "utf-8");
        const meta = parseSkillFrontmatter(content, entry.name);
        skills.push({
          id: `claude:skill:${entry.name}`,
          provider: CLAUDE_PROVIDER,
          slug: entry.name,
          name: meta.name,
          ...(meta.description ? { description: meta.description } : {}),
          ...(meta.icon ? { icon: meta.icon } : {}),
          sourcePath: skillDir
        });
      } catch (error) {
        pushWarning(
          warnings,
          "CLAUDE_SKILL_PARSE_FAILED",
          `读取 Skill 失败: ${entry.name}`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  } catch (error) {
    pushWarning(
      warnings,
      "CLAUDE_SKILLS_SCAN_FAILED",
      "扫描全局 Skills 目录失败",
      error instanceof Error ? error.message : String(error)
    );
  }
  return skills;
}

function normalizeForWindows(path: string): string {
  return normalize(path).toLowerCase();
}

function resolveMcpEntryForWorkspace(server: GlobalMcpServerMeta): McpServerEntry {
  if (server.type === "stdio") {
    return {
      type: "stdio",
      enabled: server.enabled,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {})
    };
  }

  return {
    type: server.type,
    enabled: server.enabled,
    ...(server.url ? { url: server.url } : {}),
    ...(server.headers && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {})
  };
}

export function getGlobalDiscoverySnapshot(): GlobalDiscoverySnapshot {
  const warnings: GlobalDiscoveryWarning[] = [];
  const mcpServers = parseClaudeGlobalMcp(warnings);
  const pluginMarketplaces = parseClaudeGlobalPluginMarketplaces(warnings);
  const plugins = parseClaudeGlobalPlugins(warnings);
  const skills = parseClaudeGlobalSkills(warnings);

  return {
    version: GLOBAL_DISCOVERY_VERSION,
    scannedAt: Date.now(),
    providers: [CLAUDE_PROVIDER],
    mcpServers,
    pluginMarketplaces,
    plugins,
    skills,
    warnings
  };
}

export function getGlobalMarketplaceDetail(marketplaceId: string): GlobalPluginMarketplaceDetail {
  const snapshot = getGlobalDiscoverySnapshot();
  const marketplace = snapshot.pluginMarketplaces.find((item) => item.id === marketplaceId);
  if (!marketplace) {
    throw new Error("未找到指定的 marketplace");
  }

  const warnings: GlobalDiscoveryWarning[] = [];
  const plugins = parseMarketplacePluginsFromInstallLocation(marketplace.installLocation, warnings);
  const installedPlugins = snapshot.plugins.filter((item) => item.marketplaceId === marketplace.id);

  return {
    marketplace,
    plugins,
    installedPlugins,
    warnings
  };
}

function runClaudeCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, {
      cwd: homedir(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += error.message;
      resolve({ code: 1, stdout, stderr });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function installGlobalPlugin(input: InstallGlobalPluginInput): Promise<InstallGlobalPluginResult> {
  const scope = input.scope ?? "user";
  if (!["user", "project", "local"].includes(scope)) {
    throw new Error("scope 非法，仅支持 user/project/local");
  }

  const detail = getGlobalMarketplaceDetail(input.marketplaceId);
  const pluginExists = detail.plugins.some((item) => item.name === input.pluginName);
  if (!pluginExists) {
    throw new Error("插件不存在于指定 marketplace");
  }

  const pluginId = `${input.pluginName}@${input.marketplaceId}`;
  const runResult = await runClaudeCommand(["plugin", "install", pluginId, "--scope", scope]);
  if (runResult.code !== 0) {
    const msg = (runResult.stderr || runResult.stdout || "安装失败").trim();
    throw new Error(`安装插件失败: ${msg.slice(0, 600)}`);
  }
  const output = (runResult.stdout || runResult.stderr || "安装完成").trim();
  return {
    ok: true,
    installed: true,
    message: output.slice(0, 600)
  };
}

export function importGlobalMcpToWorkspace(
  input: ImportGlobalMcpToWorkspaceInput
): GlobalImportResult {
  const snapshot = getGlobalDiscoverySnapshot();
  const target = snapshot.mcpServers.find((item) => item.id === input.mcpId);
  if (!target) {
    throw new Error("未找到指定的全局 MCP 服务器");
  }

  const current = getWorkspaceMcpConfig(input.workspaceSlug);
  const existing = current.servers[target.name];
  if (existing && !input.overwrite) {
    return { ok: true, imported: false, reason: "工作区已存在同名 MCP 服务器" };
  }

  const next = {
    servers: {
      ...current.servers,
      [target.name]: resolveMcpEntryForWorkspace(target)
    }
  };
  saveWorkspaceMcpConfig(input.workspaceSlug, next);
  return { ok: true, imported: true };
}

export function importGlobalSkillToWorkspace(
  input: ImportGlobalSkillToWorkspaceInput
): GlobalImportResult {
  const snapshot = getGlobalDiscoverySnapshot();
  const target = snapshot.skills.find((item) => item.id === input.skillId);
  if (!target) {
    throw new Error("未找到指定的全局 Skill");
  }

  const sourcePath = resolve(target.sourcePath);
  const safeGlobalRoot = resolve(CLAUDE_SKILLS_DIR);
  if (!normalizeForWindows(sourcePath).startsWith(normalizeForWindows(safeGlobalRoot))) {
    throw new Error("Skill 来源路径非法");
  }

  const targetDir = join(getWorkspaceSkillsDir(input.workspaceSlug), target.slug);
  if (existsSync(targetDir)) {
    if (!input.overwrite) {
      return { ok: true, imported: false, reason: "工作区已存在同名 Skill" };
    }
    rmSync(targetDir, { recursive: true, force: true });
  }

  cpSync(sourcePath, targetDir, { recursive: true });
  return { ok: true, imported: true };
}

export const __internal = {
  parseSkillFrontmatter,
  parseMarketplacePluginsFromInstallLocation
};
