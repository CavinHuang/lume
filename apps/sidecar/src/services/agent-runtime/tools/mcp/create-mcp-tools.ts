import type { McpCallResult, ToolDefinition, ToolResult } from "@lume/agent-sdk";
import type {
  ListMcpResourcesResponse,
  McpToolDetail,
  ReadMcpResourceResponse
} from "@lume/shared";

function toolResult(content: string, toolUseId?: string, isError?: boolean): ToolResult {
  return {
    type: "tool_result",
    tool_use_id: toolUseId ?? "",
    content,
    ...(isError ? { is_error: true } : {})
  };
}

function renderMcpCallResult(result: McpCallResult): string {
  const parts = [result.text ?? ""];
  if (result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  if (result.truncated) {
    parts.push("[truncated]");
  }
  return parts.filter(Boolean).join("\n");
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createWorkspaceMcpToolDefinitions(input: {
  workspaceSlug: string;
  tools: McpToolDetail[];
  callTool: (
    workspaceSlug: string,
    serverId: string,
    originalToolName: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal }
  ) => Promise<McpCallResult>;
}): ToolDefinition[] {
  return input.tools.map((tool) => ({
    name: tool.wrapperName,
    description: tool.description ?? `MCP tool: ${tool.originalName} from ${tool.serverName}`,
    inputSchema: (tool.inputSchema as ToolDefinition["inputSchema"] | undefined) ?? { type: "object", properties: {} },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async call(args: Record<string, unknown>, context) {
      try {
        const result = await input.callTool(
          input.workspaceSlug,
          tool.serverId,
          tool.originalName,
          args,
          { signal: context.abortSignal }
        );
        return toolResult(renderMcpCallResult(result), context.toolUseId, result.isError);
      } catch (error) {
        return toolResult(
          `MCP tool error: ${error instanceof Error ? error.message : String(error)}`,
          context.toolUseId,
          true
        );
      }
    }
  }));
}

export function createWorkspaceMcpResourceTools(input: {
  workspaceSlug: string;
  listResources: (workspaceSlug: string, serverId?: string) => Promise<ListMcpResourcesResponse>;
  readResource: (workspaceSlug: string, serverId: string, uri: string) => Promise<ReadMcpResourceResponse>;
}): ToolDefinition[] {
  return [
    {
      name: "ListMcpResourcesTool",
      description: "List MCP resources available to the current workspace.",
      inputSchema: {
        type: "object",
        properties: {
          serverId: { type: "string" }
        }
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(args: { serverId?: string }, context) {
        try {
          const result = await input.listResources(input.workspaceSlug, args.serverId);
          return toolResult(stringify(result), context.toolUseId);
        } catch (error) {
          return toolResult(
            `MCP resource list error: ${error instanceof Error ? error.message : String(error)}`,
            context.toolUseId,
            true
          );
        }
      }
    },
    {
      name: "ReadMcpResourceTool",
      description: "Read a specific MCP resource from the current workspace.",
      inputSchema: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          uri: { type: "string" }
        },
        required: ["serverId", "uri"]
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(args: { serverId?: string; uri?: string }, context) {
        if (!args.serverId?.trim() || !args.uri?.trim()) {
          return toolResult("ReadMcpResourceTool requires serverId and uri.", context.toolUseId, true);
        }
        try {
          const result = await input.readResource(input.workspaceSlug, args.serverId, args.uri);
          return toolResult(stringify(result), context.toolUseId);
        } catch (error) {
          return toolResult(
            `MCP resource read error: ${error instanceof Error ? error.message : String(error)}`,
            context.toolUseId,
            true
          );
        }
      }
    }
  ];
}
