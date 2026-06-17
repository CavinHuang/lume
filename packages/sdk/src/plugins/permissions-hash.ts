import { createHash } from "node:crypto";
import type { NormalizedPlugin } from "./normalized.js";

/**
 * Deterministic SHA-256 hash of a plugin's permission-relevant summary.
 *
 * Per design spec §16.4 the hash is canonical JSON of:
 *   - pluginId
 *   - manifestFormat
 *   - normalized permissions
 *   - sorted capability summary: skill roots, hook/mcp config paths,
 *     command tool names + execution config
 *
 * The hash EXCLUDES version, installation root, diagnostics, timestamps, and
 * enablement state. A pure version bump that keeps permissions/capabilities
 * unchanged may reuse a previous approval.
 *
 * Phase 2 scope: hooks/mcp contribute their config PATH only (resolved file
 * contents arrive with PluginCapabilityResolver in Phase 3, at which point the
 * summary input expands). Command tools are already fully resolved in
 * NormalizedPlugin, so they contribute their full execution config.
 */
export function computePermissionsHash(plugin: NormalizedPlugin): string {
  return createHash("sha256").update(stableStringify(canonicalSummary(plugin))).digest("hex");
}

interface PermissionSummary {
  pluginId: string;
  manifestFormat: string;
  permissions: unknown;
  capabilities: {
    skills: string[];
    hooksConfigPath: string | null;
    mcpServersConfigPath: string | null;
    commandTools: Array<Record<string, unknown>>;
  };
}

function canonicalSummary(plugin: NormalizedPlugin): PermissionSummary {
  const commandTools = [...plugin.capabilities.commandTools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      name: tool.name,
      command: tool.command,
      args: tool.args ?? null,
      cwd: tool.cwd ?? null,
      timeoutMs: tool.timeoutMs ?? null,
      envKeys: tool.env ? Object.keys(tool.env).sort() : [],
      inputSchema: tool.inputSchema ?? null,
    }));

  return {
    pluginId: plugin.pluginId,
    manifestFormat: plugin.manifestFormat,
    permissions: plugin.permissions,
    capabilities: {
      skills: [...plugin.capabilities.skills]
        .sort((a, b) => a.root.localeCompare(b.root))
        .map((skill) => skill.root),
      hooksConfigPath: plugin.capabilities.hooksConfigPath ?? null,
      mcpServersConfigPath: plugin.capabilities.mcpServersConfigPath ?? null,
      commandTools,
    },
  };
}

/**
 * Recursively canonicalize a value for stable serialization:
 *   - object keys sorted ascending
 *   - arrays of strings sorted
 *   - arrays of non-strings canonicalized element-wise, order preserved
 *     (execution-relevant arrays like command args keep their order; command
 *     tools themselves are pre-sorted by name in canonicalSummary).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return [...value].sort();
    }
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable JSON string: keys pre-sorted by canonicalize, output is deterministic. */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
