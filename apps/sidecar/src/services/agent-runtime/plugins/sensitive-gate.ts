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
 * 3c covers command tools only. MCP (`mcpServer:`), hooks (`hook:`), network, and
 * filesystem-write keys are deferred (MCP: §16.7 plan; hooks: Phase 3d; fs/net:
 * later extension).
 */
export async function evaluatePluginSensitiveGate(
  input: SensitiveGateInput,
): Promise<SensitiveGateResult> {
  const definition = input.descriptor.definition as {
    name: string;
    runtimeMetadata?: { pluginId?: string };
  };
  const pluginId = definition.runtimeMetadata?.pluginId;
  if (!pluginId) {
    return { decision: "allow" };
  }

  const key: SensitiveCapabilityKey = `commandTool:${definition.name}`;
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
