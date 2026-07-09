export interface AssetFileInput {
  source: string;
  fetchedAt: string; // ISO 8601 UTC
  title?: string;
  markdown: string;
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build index.md content: YAML frontmatter (source/fetched_at[/title]) + markdown body. */
export function buildAssetFile(input: AssetFileInput): string {
  const lines = ["---", `source: ${yamlString(input.source)}`, `fetched_at: ${input.fetchedAt}`];
  if (input.title !== undefined && input.title !== "") {
    lines.push(`title: ${yamlString(input.title)}`);
  }
  lines.push("---", "");
  return lines.join("\n") + input.markdown + "\n";
}
