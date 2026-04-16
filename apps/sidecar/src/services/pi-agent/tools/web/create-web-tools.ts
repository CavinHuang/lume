import { WebFetchTool, WebSearchTool, type ToolDefinition } from "@lume/agent-sdk";

export const WEB_TOOL_NAMES = ["WebSearch", "WebFetch"] as const;

export function createSdkWebTools(): ToolDefinition[] {
  return [WebSearchTool, WebFetchTool];
}
