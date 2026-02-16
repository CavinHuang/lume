/**
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/test/openclaw/src/agents/workspace.ts
 * Adaptation:
 * - Keep only frontmatter stripping utility needed by Lume bootstrap service.
 */

export function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + "\n---".length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, "");
  return trimmed;
}
