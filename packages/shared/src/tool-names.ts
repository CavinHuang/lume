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
    case "guanlansearch":
    case "guanlan_search":
      return "guanlan_search";
    case "guanlanread":
    case "guanlan_read":
      return "guanlan_read";
    case "guanlanhotnews":
    case "guanlan_hotnews":
      return "guanlan_hotnews";
    case "guanlanresearch":
    case "guanlan_research":
      return "guanlan_research";
    default:
      return normalized;
  }
}

export function isCanonicalAgentToolName(toolName: string, expected: string): boolean {
  return canonicalizeAgentToolName(toolName) === canonicalizeAgentToolName(expected);
}
