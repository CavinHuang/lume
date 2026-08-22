import { resolve } from "path";

/** Simple glob-to-regex converter supporting * and ** patterns. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLESTAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Resolve to a canonical portable path (`/` separators) so `..` segments and
 * Windows separator mixes can't smuggle a path past pattern matching (#246).
 */
function canonicalPath(...segments: string[]): string {
  return resolve(...segments).replace(/\\/g, "/");
}

export type PermissionDecision = "allow" | "deny" | "ask" | undefined;

/**
 * Resolves a relative or absolute path against the plugin root.
 * Returns absolute path string.
 */
export function resolvePluginPath(
  path: string,
  pluginRoot: string,
): string {
  return canonicalPath(pluginRoot, path);
}

/**
 * Matches an absolute path against a list of glob patterns (relative to plugin root).
 * Patterns use "./" prefix notation.
 */
export function matchPathGlob(
  absolutePath: string,
  patterns: string[],
  pluginRoot: string,
): boolean {
  const isAbsolute = absolutePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(absolutePath);
  const normalizedAbs = canonicalPath(absolutePath);
  const normalizedRoot = canonicalPath(pluginRoot);
  for (const pattern of patterns) {
    const relativePattern = pattern.startsWith("./") ? pattern.slice(2) : pattern;
    // Match either the plugin-root-anchored pattern or the root-stripped path;
    // relative inputs keep matching the relative pattern as-is.
    if (globToRegex(canonicalPath(pluginRoot, relativePattern)).test(normalizedAbs)) return true;
    const stripped = isAbsolute
      ? (normalizedAbs.startsWith(`${normalizedRoot}/`)
        ? normalizedAbs.slice(normalizedRoot.length + 1)
        : normalizedAbs)
      : absolutePath.replace(/\\/g, "/");
    if (globToRegex(relativePattern).test(stripped)) return true;
  }
  return false;
}

export function checkFilesystemPermission(
  operation: "read" | "write",
  targetPath: string,
  permissions: Record<string, unknown>,
  pluginRoot: string,
): PermissionDecision {
  const fs = permissions.filesystem as
    | { read?: string[]; write?: string[] }
    | undefined;
  if (!fs) return "ask";

  const patterns = operation === "read" ? fs.read : fs.write;
  if (!patterns || patterns.length === 0) return "ask";

  const resolved = resolvePluginPath(targetPath, pluginRoot);
  return matchPathGlob(resolved, patterns, pluginRoot) ? "allow" : "ask";
}

export function checkNetworkPermission(
  hostname: string,
  permissions: Record<string, unknown>,
): PermissionDecision {
  const network = permissions.network as { outbound?: string[] } | undefined;
  if (!network?.outbound?.length) return "ask";

  for (const pattern of network.outbound) {
    const regex = globToRegex(pattern);
    if (regex.test(hostname)) return "allow";
  }
  return "ask";
}

export function checkToolPermission(
  toolName: string,
  permissions: Record<string, unknown>,
): PermissionDecision {
  const tools = permissions.tools as
    | { allow?: string[]; deny?: string[]; ask?: string[] }
    | undefined;
  if (!tools) return undefined;

  if (tools.deny?.includes(toolName)) return "deny";
  if (tools.allow?.includes(toolName)) return "allow";
  if (tools.ask?.includes(toolName)) return "ask";
  return undefined;
}
