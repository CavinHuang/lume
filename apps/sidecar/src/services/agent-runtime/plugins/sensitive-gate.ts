import type { LumeToolDescriptor } from "../tools/tool-types.js";
import type { PluginPermissionRuntime } from "./permission-runtime.js";
import type { SensitiveCapabilityKey } from "@lume/agent-sdk";

export interface SensitiveGateInput {
  descriptor: LumeToolDescriptor;
  runtime: PluginPermissionRuntime;
  workspaceSlug?: string;
}

export interface SensitiveGateResult {
  decision: "allow" | "block";
  reason?: string;
}

/**
 * Phase 3c sensitive capability gate (design spec §8.1/§8.2/§14.2).
 *
 * For a plugin-sourced tool (descriptor.definition.runtimeMetadata.pluginId present),
 * check PluginPermissionRuntime.checkSensitiveCapability with a `commandTool:${name}`
 * key. `allow` → pass; `deny` OR `ask` → block (Phase 2's ask→block convention; Phase 4
 * replaces block-on-ask with an interactive prompt). Non-plugin tools (no pluginId)
 * pass through untouched (§8.2 source binding: built-in tools are unaffected by plugin
 * permissions).
 *
 * Covers command tools (commandTool:${name}) and plugin-MCP tools (mcpServer:${serverId},
 * §8.1) — both source-bound via runtimeMetadata.pluginId. The mcpServer key matches the
 * start gate (buildPluginMcpManager), so a server approved at start is approved at call time.
 * hooks (`hook:`), network, and filesystem-write keys remain deferred (hooks: Phase 3d gate;
 * fs/net: later extension).
 */
export async function evaluatePluginSensitiveGate(
  input: SensitiveGateInput,
): Promise<SensitiveGateResult> {
  const definition = input.descriptor.definition as {
    name: string;
    runtimeMetadata?: {
      pluginId?: string;
      capability?: string;
      mcpServerId?: string;
    };
  };
  const pluginId = definition.runtimeMetadata?.pluginId;
  if (!pluginId) {
    return { decision: "allow" };
  }

  // §8.1: plugin-MCP tools (capability "mcp" + mcpServerId) use the mcpServer:${serverId} key —
  // the SAME key the start gate (buildPluginMcpManager) uses, so a server approved at start is
  // approved at call time. Command tools keep commandTool:${name} (Phase 3c, unchanged).
  const mcpServerId = definition.runtimeMetadata?.mcpServerId;
  const isMcpTool = definition.runtimeMetadata?.capability === "mcp" && typeof mcpServerId === "string";
  const key: SensitiveCapabilityKey = isMcpTool
    ? `mcpServer:${mcpServerId}`
    : `commandTool:${definition.name}`;

  const result = await input.runtime.checkSensitiveCapability({
    pluginId,
    key,
    workspaceSlug: input.workspaceSlug,
  });

  if (result.decision === "allow") {
    return { decision: "allow" };
  }

  return {
    decision: "block",
    reason: `Plugin ${pluginId} capability ${key} blocked (sensitive, ${result.decision}): ${result.reason}`,
  };
}
