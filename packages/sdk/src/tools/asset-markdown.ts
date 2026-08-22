export interface AssetFileInput {
  source: string;
  fetchedAt: string; // ISO 8601 UTC
  title?: string;
  markdown: string;
}

function yamlString(value: string): string {
  // Keep the value on one legal YAML double-quoted line: escape the backslash
  // and quote, then newlines/tabs, then every remaining C0 control char and DEL.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  let out = "";
  for (const char of escaped) {
    const code = char.charCodeAt(0)!;
    if (code === 10) out += "\\n";
    else if (code === 13) out += "\\r";
    else if (code === 9) out += "\\t";
    else if (code < 32 || code === 127) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return `"${out}"`;
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
