import {
  buildCommandToolDefinition,
  type PluginDiagnostic,
  type SkillDefinition,
  type ToolDefinition,
} from "@lume/agent-sdk";
import { resolvePluginCapabilities } from "./capability-resolver.js";
import type { RegisteredPlugin } from "./plugin-registry.js";

export interface PluginRuntimeAssembly {
  /** Plugin command-tool ToolDefinitions; each carries `runtimeMetadata.pluginId` (name is unchanged). */
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
 * Sensitive-use gating is Phase 3c — the ToolDefinitions built here carry the source
 * `pluginId` in `runtimeMetadata.pluginId` so 3c's canUseTool gate (which receives the
 * full ToolDefinition) can recover the source without changing the tool's exposed name.
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
      // Carry pluginId in runtimeMetadata so Phase 3c's canUseTool gate (which receives
      // the full ToolDefinition) can recover the source pluginId without changing the
      // tool's exposed name.
      definition.runtimeMetadata = {
        ...(definition.runtimeMetadata ?? {}),
        pluginId: capability.pluginId,
      };
      commandToolDefinitions.push(definition);
    }
    for (const skill of capability.skills) {
      skills.push(skill.definition);
    }
  }

  return { commandToolDefinitions, skills, diagnostics: resolved.diagnostics };
}
