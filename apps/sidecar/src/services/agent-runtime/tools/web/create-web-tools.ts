import {
  GuanlanHotnewsTool,
  GuanlanReadTool,
  GuanlanResearchTool,
  GuanlanSearchTool,
  WebFetchTool,
  WebSearchTool,
  defineTool,
  fetchIdFromUrl,
  runWebFetch,
  type RenderClient,
  type ToolDefinition
} from "@lume/agent-sdk";
import { join } from "node:path";
import { getWorkspaceResourcesPath } from "../../../infra/config-paths";

export const WEB_TOOL_NAMES = [
  "WebSearch",
  "WebFetch",
  "guanlan_search",
  "guanlan_read",
  "guanlan_hotnews",
  "guanlan_research"
] as const;

export interface CreateSdkWebToolsInput {
  /** Per-session workspace slug; enables on-disk asset persistence for WebFetch. */
  workspaceSlug?: string;
  /** Reverse-RPC client to the desktop renderer; enables JS-rendered fetches. */
  renderClient?: RenderClient;
}

/**
 * Build the SDK web toolset. WebFetch is wrapped so the sidecar can inject a
 * renderClient (reverse-RPC bridge to the desktop PageRenderer) and an asset
 * dir resolver keyed off the workspace slug. When neither is supplied the tool
 * behaves exactly like the stock SDK WebFetch (static fetch, no asset write).
 */
export function createSdkWebTools(input: CreateSdkWebToolsInput = {}): ToolDefinition[] {
  return [
    WebSearchTool,
    createEnhancedWebFetch(input),
    GuanlanSearchTool,
    GuanlanReadTool,
    GuanlanHotnewsTool,
    GuanlanResearchTool
  ];
}

function createEnhancedWebFetch(input: CreateSdkWebToolsInput): ToolDefinition {
  const { workspaceSlug, renderClient } = input;
  return defineTool({
    name: "WebFetch",
    description: WebFetchTool.description ?? "Fetch a URL as Markdown.",
    inputSchema: WebFetchTool.inputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(toolInput, context) {
      return runWebFetch(toolInput, context, {
        renderClient,
        resolveAssetDir: workspaceSlug
          ? (url) => join(getWorkspaceResourcesPath(workspaceSlug), "fetches", fetchIdFromUrl(url))
          : undefined
      });
    }
  });
}
