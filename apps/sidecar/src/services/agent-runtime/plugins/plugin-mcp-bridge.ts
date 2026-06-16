import type { McpServerEntry, WorkspaceMcpConfig } from "@lume/shared";
import {
  WorkspaceMcpManager,
  type McpGateDecision,
  type WorkspaceSdkMcpManager,
} from "../../mcp/workspace-mcp-manager.js";
import type { PluginPermissionRuntime } from "./permission-runtime.js";
import type { ResolvedMcpServer } from "./capability-resolver.js";

/** Distinct slug so the plugin MCP pool never touches the workspace singleton's state. */
export const PLUGIN_MCP_WORKSPACE_SLUG = "__plugin__";

export interface BuildPluginMcpManagerOptions {
  /** §8.1 start gate. When provided, each server is checked before connect; deny/ask blocks connect. */
  permissionRuntime?: PluginPermissionRuntime;
  workspaceSlug?: string;
  /** Test seam (mirrors WorkspaceMcpManagerOptions.sdkManagerFactory). */
  sdkManagerFactory?: () => WorkspaceSdkMcpManager;
}

/** Build a `${pluginId}:${serverId}` → pluginId index (shared by the start gate + tool stamping). */
export function buildPluginIdIndex(servers: ResolvedMcpServer[]): Map<string, string> {
  return new Map(servers.map((server) => [`${server.pluginId}:${server.serverId}`, server.pluginId]));
}

/**
 * Build a TRANSIENT WorkspaceMcpManager for plugin-declared MCP servers (spec §6.4/§16.7/§8.1).
 *
 * Independent of the getWorkspaceMcpManager() singleton — plugin servers never pollute the
 * workspace MCP pool. Server ids are namespaced `${pluginId}:${serverId}` to avoid cross-plugin
 * collisions. Lifecycle: caller must disposeWorkspace on session end (§16.7).
 *
 * §8.1 start gate: when `permissionRuntime` is provided, `syncWorkspace`'s connect loop calls
 * `checkSensitiveCapability({ pluginId, key: `mcpServer:${serverId}` })` per server before connect;
 * `deny`/`ask` skip connect (Phase 2 ask→block; Phase 4 adds UI). The call gate in sensitive-gate.ts
 * reuses the same key, so a server approved here is approved at call time too.
 */
export function buildPluginMcpManager(
  servers: ResolvedMcpServer[],
  options: BuildPluginMcpManagerOptions = {},
): WorkspaceMcpManager {
  const pluginIdByServerId = buildPluginIdIndex(servers);
  const namespaced: WorkspaceMcpConfig = { servers: {} };
  for (const server of servers) {
    const id = `${server.pluginId}:${server.serverId}`;
    namespaced.servers[id] = server.entry as McpServerEntry;
  }

  const { permissionRuntime, workspaceSlug, sdkManagerFactory } = options;
  const authorizeConnect = permissionRuntime
    ? async (serverId: string): Promise<McpGateDecision> => {
        const pluginId = pluginIdByServerId.get(serverId);
        if (!pluginId) {
          return { decision: "allow" };
        }
        const result = await permissionRuntime.checkSensitiveCapability({
          pluginId,
          key: `mcpServer:${serverId}`,
          workspaceSlug,
        });
        if (result.decision === "allow") {
          return { decision: "allow" };
        }
        return {
          decision: "block",
          reason: `Plugin ${pluginId} MCP server ${serverId} blocked (sensitive, ${result.decision}): ${result.reason}`,
        };
      }
    : undefined;

  return new WorkspaceMcpManager({
    readConfig: () => namespaced,
    ...(sdkManagerFactory ? { sdkManagerFactory } : {}),
    ...(authorizeConnect ? { authorizeConnect } : {}),
  });
}
