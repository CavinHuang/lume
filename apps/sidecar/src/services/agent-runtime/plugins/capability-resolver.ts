import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadFilesystemSkills,
  type CommandToolContribution,
  type HookConfig,
  type HookDefinition,
  type PluginDiagnostic,
  type SkillDefinition,
} from "@lume/agent-sdk";
import { parseMcpImportPayload, type McpServerEntry } from "@lume/shared";
import type { RegisteredPlugin } from "./plugin-registry.js";

export interface ResolvedSkill {
  pluginId: string;
  /** Namespaced name: `${pluginId}:${originalName}`. */
  name: string;
  originalName: string;
  sourcePath: string;
  definition: SkillDefinition;
}

export interface ResolvedMcpServer {
  pluginId: string;
  serverId: string;
  entry: McpServerEntry;
}

export interface ResolvedCommandTool {
  pluginId: string;
  contribution: CommandToolContribution;
}

export interface ResolvedPluginCapability {
  pluginId: string;
  skills: ResolvedSkill[];
  hooks: HookConfig;
  mcpServers: ResolvedMcpServer[];
  commandTools: ResolvedCommandTool[];
  diagnostics: PluginDiagnostic[];
}

export interface ResolvedPluginCapabilitiesResult {
  capabilities: ResolvedPluginCapability[];
  diagnostics: PluginDiagnostic[];
}

/**
 * Resolve runtime capabilities for a set of registered plugins (design spec §6.3).
 *
 * Plugins whose `permissionState.state` is not "loaded" are silently omitted —
 * `PluginRegistry.list` already emitted their `permission_review_required` /
 * `capability_filtered` diagnostics. Loaded plugins are resolved skill-by-skill,
 * hook-by-hook, etc.; per-capability failures become diagnostics, never crashes.
 */
export async function resolvePluginCapabilities(
  plugins: RegisteredPlugin[],
): Promise<ResolvedPluginCapabilitiesResult> {
  const capabilities: ResolvedPluginCapability[] = [];
  const diagnostics: PluginDiagnostic[] = [];

  for (const plugin of plugins) {
    if (plugin.permissionState?.state !== "loaded") {
      continue;
    }
    const resolved = await resolveOne(plugin);
    capabilities.push(resolved);
    diagnostics.push(...resolved.diagnostics);
  }

  return { capabilities, diagnostics };
}

async function resolveOne(plugin: RegisteredPlugin): Promise<ResolvedPluginCapability> {
  const diagnostics: PluginDiagnostic[] = [];
  const skills = await resolveSkills(plugin, diagnostics);
  const hooks = await resolveHooks(plugin, diagnostics);
  const mcpServers = await resolveMcpServers(plugin, diagnostics);
  const commandTools = resolveCommandTools(plugin);
  return { pluginId: plugin.pluginId, skills, hooks, mcpServers, commandTools, diagnostics };
}

// Stubs — filled in by later tasks (skills, hooks, MCP, commandTools).
async function resolveSkills(
  plugin: RegisteredPlugin,
  diagnostics: PluginDiagnostic[],
): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = [];
  for (const contribution of plugin.capabilities.skills) {
    const skillsRoot = resolve(plugin.root, contribution.root);
    let skills: SkillDefinition[];
    try {
      skills = await loadFilesystemSkills({ roots: [skillsRoot], cwd: skillsRoot });
    } catch (error) {
      diagnostics.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        severity: "warning",
        code: "invalid_manifest",
        message: `Failed to read skills from ${contribution.root}: ${error instanceof Error ? error.message : String(error)}`,
        path: contribution.root,
      });
      continue;
    }
    for (const skill of skills) {
      const namespaced = `${plugin.pluginId}:${skill.name}`;
      resolved.push({
        pluginId: plugin.pluginId,
        name: namespaced,
        originalName: skill.name,
        sourcePath: skill.sourcePath ?? skillsRoot,
        definition: { ...skill, name: namespaced },
      });
    }
  }
  return resolved;
}

async function resolveHooks(
  plugin: RegisteredPlugin,
  diagnostics: PluginDiagnostic[],
): Promise<HookConfig> {
  if (!plugin.capabilities.hooksConfigPath) return {};

  const hooksFile = resolve(plugin.root, plugin.capabilities.hooksConfigPath);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(hooksFile, "utf-8")) as Record<string, unknown>;
  } catch (error) {
    diagnostics.push({
      pluginId: plugin.pluginId,
      version: plugin.version,
      severity: "warning",
      code: "invalid_manifest",
      message: `Failed to read hooks config ${plugin.capabilities.hooksConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      path: plugin.capabilities.hooksConfigPath,
    });
    return {};
  }

  // Codex wraps as { hooks: { Event: [...] } }; a flat object is also accepted.
  const configRoot =
    raw.hooks && typeof raw.hooks === "object" && !Array.isArray(raw.hooks)
      ? (raw.hooks as Record<string, unknown>)
      : raw;

  const allowed = new Set(plugin.permissions.hooks?.events ?? []);
  const result: HookConfig = {};
  for (const [event, definitions] of Object.entries(configRoot)) {
    if (!Array.isArray(definitions)) continue;
    if (!allowed.has(event)) {
      diagnostics.push({
        pluginId: plugin.pluginId,
        version: plugin.version,
        severity: "info",
        code: "capability_filtered",
        message: `Hook event ${event} is not declared in permissions.hooks.events; filtered.`,
        path: plugin.capabilities.hooksConfigPath,
      });
      continue;
    }
    result[event] = definitions.map((def) => {
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        return def as HookDefinition;
      }
      const { type: _type, ...rest } = def as Record<string, unknown>;
      return rest as HookDefinition;
    });
  }
  return result;
}

async function resolveMcpServers(
  plugin: RegisteredPlugin,
  diagnostics: PluginDiagnostic[],
): Promise<ResolvedMcpServer[]> {
  if (!plugin.capabilities.mcpServersConfigPath) return [];

  if (plugin.permissions.mcpServers?.register === false) {
    diagnostics.push({
      pluginId: plugin.pluginId,
      version: plugin.version,
      severity: "info",
      code: "capability_filtered",
      message: "MCP servers skipped because permissions.mcpServers.register is false.",
      path: plugin.capabilities.mcpServersConfigPath,
    });
    return [];
  }

  const mcpFile = resolve(plugin.root, plugin.capabilities.mcpServersConfigPath);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(mcpFile, "utf-8"));
  } catch (error) {
    diagnostics.push({
      pluginId: plugin.pluginId,
      version: plugin.version,
      severity: "warning",
      code: "invalid_manifest",
      message: `Failed to read MCP config ${plugin.capabilities.mcpServersConfigPath}: ${error instanceof Error ? error.message : String(error)}`,
      path: plugin.capabilities.mcpServersConfigPath,
    });
    return [];
  }

  const config = parseMcpImportPayload(raw);
  return Object.entries(config.servers).map(([serverId, entry]) => ({
    pluginId: plugin.pluginId,
    serverId,
    entry,
  }));
}

function resolveCommandTools(_plugin: RegisteredPlugin): ResolvedCommandTool[] {
  return [];
}
