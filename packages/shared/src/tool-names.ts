/** 内置浏览器 MCP 工具的 server id 与注入名前缀（mcp__browser__*），工具名单的唯一权威来源 */
export const BROWSER_MCP_SERVER_ID = "browser";
export const BROWSER_TOOL_NAME_PREFIX = `mcp__${BROWSER_MCP_SERVER_ID}__`;

export function isBuiltinBrowserToolName(toolName: string): boolean {
  return toolName.startsWith(BROWSER_TOOL_NAME_PREFIX);
}

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
    case "agent":
    case "agent_spawn":
      return "agent_spawn";
    default:
      return normalized;
  }
}

export function isCanonicalAgentToolName(toolName: string, expected: string): boolean {
  return canonicalizeAgentToolName(toolName) === canonicalizeAgentToolName(expected);
}
