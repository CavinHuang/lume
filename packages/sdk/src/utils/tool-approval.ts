export function matchesToolPattern(
  toolName: string,
  pattern: string,
): boolean {
  if (!pattern) return false
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1))
  }
  return toolName === pattern
}

export function matchesAnyToolPattern(
  toolName: string,
  patterns?: string[],
): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((pattern) => matchesToolPattern(toolName, pattern))
}
