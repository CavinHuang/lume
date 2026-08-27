/**
 * Shared pattern matching utilities for tool-policy and memory-policy.
 *
 * Both policy systems compile glob-like allow/deny patterns into a uniform
 * representation for fast matching. This module extracts the common logic
 * to avoid duplication.
 */

export type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

/**
 * Compile a single raw pattern string into a `CompiledPattern`.
 * @param raw - The raw pattern string (e.g. `"read"`, `"web_*"`, `"*"`).
 * @param normalizeFn - Domain-specific normalizer (e.g. `normalizeToolName`).
 */
export function compilePattern(raw: string, normalizeFn: (s: string) => string): CompiledPattern {
  const pattern = normalizeFn(raw);
  if (!pattern) {
    return { kind: "exact", value: "" };
  }
  if (pattern === "*") {
    return { kind: "all" };
  }
  if (!pattern.includes("*")) {
    return { kind: "exact", value: pattern };
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    kind: "regex",
    value: new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`)
  };
}

/**
 * Compile an array of raw pattern entries, filtering out empty results.
 * @param entries - Raw pattern strings.
 * @param normalizeFn - Domain-specific normalizer.
 */
export function compilePatterns(entries: string[], normalizeFn: (s: string) => string): CompiledPattern[] {
  return entries
    .map((entry) => compilePattern(entry, normalizeFn))
    .filter((entry) => entry.kind !== "exact" || entry.value.length > 0);
}

/**
 * Check whether `name` matches any of the compiled patterns.
 */
export function matchesAny(name: string, patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") return true;
    if (pattern.kind === "exact" && pattern.value === name) return true;
    if (pattern.kind === "regex" && pattern.value.test(name)) return true;
  }
  return false;
}

