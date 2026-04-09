export function canonicalizeAgentToolName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  switch (normalized) {
    case "read":
      return "read";
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "bash":
      return "bash";
    case "glob":
    case "find":
      return "find";
    case "grep":
      return "grep";
    case "ls":
      return "ls";
    case "websearch":
    case "web_search":
      return "web_search";
    case "webfetch":
    case "web_fetch":
      return "web_fetch";
    default:
      return normalized;
  }
}

export function isCanonicalAgentToolName(toolName: string, expected: string): boolean {
  return canonicalizeAgentToolName(toolName) === canonicalizeAgentToolName(expected);
}
