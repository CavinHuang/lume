export function buildToolingSection(_inputTools?: string[]): string[] {
  return [
    "## Tooling",
    "Call only tools actually exposed by the runtime tool schema; do not invent tool names."
  ];
}
