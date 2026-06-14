import {
  buildCommandToolDefinition,
  type PluginDiagnostic,
  type SkillDefinition,
  type ToolDefinition,
} from "@lume/agent-sdk";
import { resolvePluginCapabilities } from "./capability-resolver.js";
import type { RegisteredPlugin } from "./plugin-registry.js";

export interface PluginRuntimeAssembly {
  /** Plugin command-tool ToolDefinitions, each name namespaced `${pluginId}:${name}`. */
  commandToolDefinitions: ToolDefinition[];
  /** Namespaced skill definitions (resolver already rewrote skill.name). */
  skills: SkillDefinition[];
  /** Cross-plugin diagnostics from the resolver. */
  diagnostics: PluginDiagnostic[];
}

/**
 * Phase 3b PluginRuntimeBridge (design spec §6.4): turn RegisteredPlugin[] into
 * runtime-ready command-tool ToolDefinitions + skills, via the Phase 3a resolver.
 *
 * Pure function of `plugins` — no registry, no filesystem beyond what the resolver
 * already does. MCP servers and hooks are intentionally NOT wired here (MCP: §16.7
 * lifecycle, separate plan; hooks: Phase 3d).
 *
 * Sensitive-use gating is Phase 3c — the ToolDefinitions built here carry a
 * `${pluginId}:` namespaced name so 3c's canUseTool gate can recover the source.
 */
export async function assemblePluginRuntime(
  plugins: RegisteredPlugin[],
): Promise<PluginRuntimeAssembly> {
  const rootById = new Map(plugins.map((plugin) => [plugin.pluginId, plugin.root]));
  const resolved = await resolvePluginCapabilities(plugins);

  const commandToolDefinitions: ToolDefinition[] = [];
  const skills: SkillDefinition[] = [];

  for (const capability of resolved.capabilities) {
    const pluginRoot = rootById.get(capability.pluginId);
    for (const tool of capability.commandTools) {
      if (!pluginRoot) continue;
      const definition = buildCommandToolDefinition(tool.contribution, pluginRoot);
      // Namespace so Phase 3c can recover the source pluginId from the tool name.
      definition.name = `${capability.pluginId}:${definition.name}`;
      commandToolDefinitions.push(definition);
    }
    for (const skill of capability.skills) {
      skills.push(skill.definition);
    }
  }

  return { commandToolDefinitions, skills, diagnostics: resolved.diagnostics };
}
