import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
 * Hooks/MCP/LSP config files contribute both their path and their content
 * hash (#347): hooks and MCP servers are command-execution entry points, so a
 * post-approval edit of hooks.json / mcp.json must force a re-review just like
 * a commandTool change does. Command tools are fully resolved in
 * NormalizedPlugin, so they contribute their full execution config including
 * env values and metadata (#315).
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
    hooksConfigHash: string | null;
    mcpServersConfigPath: string | null;
    mcpServersConfigHash: string | null;
    lspServersConfigPath: string | null;
    lspServersConfigHash: string | null;
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
      // Full key/value pairs and metadata: flipping metadata.isReadOnly changes
      // permission classification and swapping an env value rewrites what the
      // approved command talks to — both must force a re-review (#315).
      env: tool.env ?? null,
      metadata: tool.metadata ?? null,
      inputSchema: tool.inputSchema ?? null,
    }));

  return {
    pluginId: plugin.pluginId,
    manifestFormat: plugin.manifestFormat,
    // Permission lists (read/write patterns, outbound hosts, tool allow/deny/
    // ask) are unordered sets and are sorted for order-independent hashing.
    permissions: deepSortStringArrays(plugin.permissions),
    capabilities: {
      skills: [...plugin.capabilities.skills]
        .sort((a, b) => a.root.localeCompare(b.root))
        .map((skill) => skill.root),
      hooksConfigPath: plugin.capabilities.hooksConfigPath ?? null,
      hooksConfigHash: capabilityFileHash(plugin, plugin.capabilities.hooksConfigPath),
      mcpServersConfigPath: plugin.capabilities.mcpServersConfigPath ?? null,
      mcpServersConfigHash: capabilityFileHash(plugin, plugin.capabilities.mcpServersConfigPath),
      lspServersConfigPath: plugin.capabilities.lspServersConfigPath ?? null,
      lspServersConfigHash: capabilityFileHash(plugin, plugin.capabilities.lspServersConfigPath),
      commandTools,
    },
  };
}

function capabilityFileHash(plugin: NormalizedPlugin, path: string | undefined): string | null {
  if (!path) return null;
  try {
    return createHash("sha256").update(readFileSync(resolve(plugin.root, path))).digest("hex");
  } catch {
    return "missing";
  }
}

/**
 * Recursively canonicalize a value for stable serialization:
 *   - object keys sorted ascending
 *   - arrays keep their order. Execution-relevant sequences like commandTool
 *     args are position-sensitive (reordering `cp A B` into `cp B A` must
 *     change the hash), and order-insensitive collections are pre-sorted by
 *     canonicalSummary / deepSortStringArrays instead.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
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

/** Deeply sort string arrays inside a value — permission lists are unordered sets. */
function deepSortStringArrays(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return [...value].sort();
    }
    return value.map(deepSortStringArrays);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepSortStringArrays(entry);
    }
    return out;
  }
  return value;
}

/** Stable JSON string: keys pre-sorted by canonicalize, output is deterministic. */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
