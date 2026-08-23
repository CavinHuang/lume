import type { EnabledPluginContextItem } from "../../agent/agent-prompt-builder";
import type { RegisteredPlugin } from "../plugins/plugin-registry.js";
import type { PluginRuntimeAssembly } from "../plugins/runtime-bridge.js";

export function buildEnabledPluginContext(
  plugins: RegisteredPlugin[],
  assembly: PluginRuntimeAssembly,
): EnabledPluginContextItem[] {
  if (plugins.length === 0) return [];

  const skillsByPlugin = new Map<string, EnabledPluginContextItem["skills"]>();
  for (const skill of assembly.skills) {
    const pluginId = skill.name.split(":")[0];
    if (!pluginId) continue;
    const skills = skillsByPlugin.get(pluginId) ?? [];
    skills.push({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
    });
    skillsByPlugin.set(pluginId, skills);
  }

  const commandToolsByPlugin = new Map<string, string[]>();
  for (const tool of assembly.commandToolDefinitions) {
    const runtimeMetadata = tool.runtimeMetadata as
      { pluginId?: string } | undefined;
    const pluginId = runtimeMetadata?.pluginId;
    if (!pluginId) continue;
    const tools = commandToolsByPlugin.get(pluginId) ?? [];
    tools.push(tool.name);
    commandToolsByPlugin.set(pluginId, tools);
  }

  const mcpServersByPlugin = new Map<string, string[]>();
  for (const server of assembly.mcpServers) {
    const servers = mcpServersByPlugin.get(server.pluginId) ?? [];
    servers.push(`${server.pluginId}:${server.serverId}`);
    mcpServersByPlugin.set(server.pluginId, servers);
  }

  const diagnosticsByPlugin = new Map<string, string[]>();
  for (const diagnostic of assembly.diagnostics) {
    if (!diagnostic.pluginId) continue;
    const diagnostics = diagnosticsByPlugin.get(diagnostic.pluginId) ?? [];
    diagnostics.push(diagnostic.message);
    diagnosticsByPlugin.set(diagnostic.pluginId, diagnostics);
  }

  return plugins.map((plugin) => {
    const diagnostics = [
      ...plugin.diagnostics.map((diagnostic) => diagnostic.message),
      ...(diagnosticsByPlugin.get(plugin.pluginId) ?? []),
    ];
    if (plugin.permissionState && plugin.permissionState.state !== "loaded") {
      diagnostics.push(
        `${plugin.permissionState.state}: ${plugin.permissionState.reason}`,
      );
    }
    return {
      pluginId: plugin.pluginId,
      ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
      ...(plugin.description ? { description: plugin.description } : {}),
      skills: skillsByPlugin.get(plugin.pluginId) ?? [],
      commandTools: commandToolsByPlugin.get(plugin.pluginId) ?? [],
      mcpServers: mcpServersByPlugin.get(plugin.pluginId) ?? [],
      diagnostics: Array.from(new Set(diagnostics)),
    };
  });
}
