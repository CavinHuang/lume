export function buildToolingSection(_inputTools?: string[]): string[] {
  return [
    "## Tooling",
    "Available tools are provided by the runtime tool schema for this request.",
    "Call only tools actually exposed by runtime; do not invent tool names.",
    "Tool names are case-sensitive. Use the exact name shown in the tool schema."
  ];
}
