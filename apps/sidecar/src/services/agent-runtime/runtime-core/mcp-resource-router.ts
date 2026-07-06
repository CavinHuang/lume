import type { ToolDefinition } from "@lume/agent-sdk";
import type { ListMcpResourcesResponse, ReadMcpResourceResponse } from "@lume/shared";
import type { WorkspaceMcpManager } from "../../mcp/workspace-mcp-manager";
import { createWorkspaceMcpResourceTools } from "../tools/mcp/create-mcp-tools";
import type { ResolvedMcpServer } from "../plugins/capability-resolver";
import { PLUGIN_MCP_WORKSPACE_SLUG } from "../plugins/plugin-mcp-bridge";

type McpResourceManager = Pick<WorkspaceMcpManager, "listResources" | "readResource">;

const MCP_RESOURCE_TOOL_NAMES = new Set(["ListMcpResourcesTool", "ReadMcpResourceTool"]);

export function createPluginAwareMcpResourceTools(input: {
  workspaceSlug: string;
  pluginServers: ResolvedMcpServer[];
  workspaceMcpManager: McpResourceManager;
  pluginMcpManager: McpResourceManager;
}): ToolDefinition[] {
  const pluginServerAliases = buildPluginMcpServerAliasMap(input.pluginServers);

  return createWorkspaceMcpResourceTools({
    workspaceSlug: input.workspaceSlug,
    listResources: async (workspaceSlug, serverId) => {
      const pluginServerId = resolvePluginMcpServerId(pluginServerAliases, serverId);
      if (pluginServerId) {
        return input.pluginMcpManager.listResources({
          workspaceSlug: PLUGIN_MCP_WORKSPACE_SLUG,
          serverId: pluginServerId,
        });
      }
      if (serverId?.trim()) {
        return input.workspaceMcpManager.listResources({ workspaceSlug, serverId });
      }

      const [workspaceResources, pluginResources] = await Promise.all([
        input.workspaceMcpManager.listResources({ workspaceSlug }),
        input.pluginMcpManager.listResources({ workspaceSlug: PLUGIN_MCP_WORKSPACE_SLUG }),
      ]);
      return mergeResourceLists(workspaceResources, pluginResources);
    },
    readResource: async (workspaceSlug, serverId, uri) => {
      const pluginServerId = resolvePluginMcpServerId(pluginServerAliases, serverId);
      if (pluginServerId) {
        return input.pluginMcpManager.readResource({
          workspaceSlug: PLUGIN_MCP_WORKSPACE_SLUG,
          serverId: pluginServerId,
          uri,
        });
      }
      return input.workspaceMcpManager.readResource({ workspaceSlug, serverId, uri });
    },
  });
}

export function replaceMcpResourceTools(
  tools: ToolDefinition[],
  resourceTools: ToolDefinition[],
): ToolDefinition[] {
  if (resourceTools.length === 0) {
    return tools;
  }
  return [
    ...tools.filter((tool) => !MCP_RESOURCE_TOOL_NAMES.has(tool.name)),
    ...resourceTools,
  ];
}

function buildPluginMcpServerAliasMap(servers: ResolvedMcpServer[]): Map<string, string> {
  const aliases = new Map<string, Set<string>>();
  const byPluginId = new Map<string, string[]>();

  for (const server of servers) {
    const namespaced = `${server.pluginId}:${server.serverId}`;
    addAlias(aliases, namespaced, namespaced);
    addAlias(aliases, server.serverId, namespaced);

    const pluginServers = byPluginId.get(server.pluginId) ?? [];
    pluginServers.push(namespaced);
    byPluginId.set(server.pluginId, pluginServers);
  }

  for (const [pluginId, pluginServers] of byPluginId.entries()) {
    if (pluginServers.length === 1) {
      addAlias(aliases, pluginId, pluginServers[0]!);
    }
  }

  const resolved = new Map<string, string>();
  for (const [alias, targets] of aliases.entries()) {
    if (targets.size !== 1) {
      continue;
    }
    resolved.set(alias, [...targets][0]!);
  }
  return resolved;
}

function resolvePluginMcpServerId(
  aliases: Map<string, string>,
  serverId?: string,
): string | undefined {
  const key = serverId?.trim();
  return key ? aliases.get(key) : undefined;
}

function addAlias(aliases: Map<string, Set<string>>, alias: string, target: string): void {
  const key = alias.trim();
  if (!key) {
    return;
  }
  const targets = aliases.get(key) ?? new Set<string>();
  targets.add(target);
  aliases.set(key, targets);
}

function mergeResourceLists(
  workspaceResources: ListMcpResourcesResponse,
  pluginResources: ListMcpResourcesResponse,
): ListMcpResourcesResponse {
  const errors = [
    ...(workspaceResources.errors ?? []),
    ...(pluginResources.errors ?? []),
  ];
  return {
    resources: [
      ...workspaceResources.resources,
      ...pluginResources.resources,
    ],
    ...(errors.length > 0 ? { errors } : {}),
  };
}
