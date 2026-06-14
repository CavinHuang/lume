import { resolve } from "node:path";
import type {
  CommandToolContribution,
  HookConfig,
  PluginDiagnostic,
  SkillDefinition,
} from "@lume/agent-sdk";
import type { McpServerEntry } from "@lume/shared";
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
  _plugin: RegisteredPlugin,
  _diagnostics: PluginDiagnostic[],
): Promise<ResolvedSkill[]> {
  return [];
}

async function resolveHooks(
  _plugin: RegisteredPlugin,
  _diagnostics: PluginDiagnostic[],
): Promise<HookConfig> {
  return {};
}

async function resolveMcpServers(
  _plugin: RegisteredPlugin,
  _diagnostics: PluginDiagnostic[],
): Promise<ResolvedMcpServer[]> {
  return [];
}

function resolveCommandTools(_plugin: RegisteredPlugin): ResolvedCommandTool[] {
  return [];
}
