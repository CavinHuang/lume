/**
 * Shared MCP tool-name assembly.
 *
 * Every `mcp__<server>__<tool>` name that reaches a provider API is built
 * through these helpers: identifiers are normalized to legal characters and
 * clamped to a provider-safe length, so a hostile or sloppy server name can
 * never produce a 400 for the whole request (#326).
 */

export const MAX_MCP_TOOL_NAME_LENGTH = 64;

export function normalizeMcpServerId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'server';
}

export function normalizeMcpToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'tool';
}

export function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

/**
 * Build the wrapper tool name for an MCP tool. Deterministic; names beyond
 * the length cap are disambiguated by a short hash of the full identity.
 */
export function buildMcpToolName(serverName: string, originalToolName: string): string {
  const server = normalizeMcpServerId(serverName);
  const tool = normalizeMcpToolName(originalToolName);
  const joined = `mcp__${server}__${tool}`;
  if (joined.length <= MAX_MCP_TOOL_NAME_LENGTH) {
    return joined;
  }
  const suffix = shortHash(`${server}\0${tool}`);
  const keep = MAX_MCP_TOOL_NAME_LENGTH - suffix.length - 1;
  return `${joined.slice(0, keep)}_${suffix}`;
}
