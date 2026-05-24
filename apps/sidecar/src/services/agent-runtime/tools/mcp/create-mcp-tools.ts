import type { McpCallResult, ToolDefinition, ToolResult } from "@lume/agent-sdk";
import type {
  ListMcpResourcesResponse,
  McpServerStatus,
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
  isToolEnabled?: (workspaceSlug: string, tool: McpToolDetail) => boolean;
}): ToolDefinition[] {
  return input.tools.map((tool) => ({
    name: tool.wrapperName,
    description: tool.description ?? `MCP tool: ${tool.originalName} from ${tool.serverName}`,
    inputSchema: (tool.inputSchema as ToolDefinition["inputSchema"] | undefined) ?? { type: "object", properties: {} },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => input.isToolEnabled?.(input.workspaceSlug, tool) ?? true,
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

function listToolDetails(status: McpServerStatus): Array<{
  originalName: string;
  wrapperName: string;
  description?: string;
}> {
  if (status.toolDetails.length > 0) {
    return status.toolDetails.map((tool) => ({
      originalName: tool.originalName,
      wrapperName: tool.wrapperName,
      ...(tool.description ? { description: tool.description } : {})
    }));
  }
  return status.tools.map((toolName) => ({
    originalName: toolName,
    wrapperName: toolName
  }));
}

export function createWorkspaceMcpConfigTool(input: {
  workspaceSlug: string;
  getStatus: (workspaceSlug: string) => McpServerStatus[] | Promise<McpServerStatus[]>;
}): ToolDefinition {
  return {
    name: "McpConfigTool",
    description: "List MCP servers and loaded MCP tools for the current workspace.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: { type: "string" }
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    runtimeMetadata: {
      title: "MCP Config",
      category: "read",
      capability: "mcp",
      riskLevel: "low",
      sideEffects: "none",
      allowedInPlanMode: true,
      isReadOnly: true,
      isConcurrencySafe: true,
      requiresApprovalByDefault: false
    },
    async call(args: { serverId?: string }, context) {
      try {
        const statuses = await input.getStatus(input.workspaceSlug);
        const serverId = args.serverId?.trim();
        const servers = statuses
          .filter((status) => !serverId || status.serverId === serverId)
          .map((status) => ({
            serverId: status.serverId,
            name: status.name,
            transport: status.transport,
            enabled: status.enabled,
            status: status.status,
            tools: listToolDetails(status),
            ...(status.error ? { error: status.error } : {})
          }));
        return toolResult(stringify({ workspaceSlug: input.workspaceSlug, servers }), context.toolUseId);
      } catch (error) {
        return toolResult(
          `MCP config error: ${error instanceof Error ? error.message : String(error)}`,
          context.toolUseId,
          true
        );
      }
    }
  };
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
