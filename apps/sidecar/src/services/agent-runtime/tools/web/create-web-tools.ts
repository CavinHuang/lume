import {
  GuanlanHotnewsTool,
  GuanlanReadTool,
  GuanlanResearchTool,
  GuanlanSearchTool,
  WebFetchTool,
  WebSearchTool,
  type ToolDefinition
} from "@lume/agent-sdk";

export const WEB_TOOL_NAMES = [
  "WebSearch",
  "WebFetch",
  "guanlan_search",
  "guanlan_read",
  "guanlan_hotnews",
  "guanlan_research"
] as const;

export function createSdkWebTools(): ToolDefinition[] {
  return [
    WebSearchTool,
    WebFetchTool,
    GuanlanSearchTool,
    GuanlanReadTool,
    GuanlanHotnewsTool,
    GuanlanResearchTool
  ];
}
