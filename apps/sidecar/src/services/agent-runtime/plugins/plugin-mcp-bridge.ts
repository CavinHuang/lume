import type { McpServerEntry, WorkspaceMcpConfig } from "@lume/shared";
import { WorkspaceMcpManager } from "../../mcp/workspace-mcp-manager.js";
import type { ResolvedMcpServer } from "./capability-resolver.js";

/** Distinct slug so the plugin MCP pool never touches the workspace singleton's state. */
export const PLUGIN_MCP_WORKSPACE_SLUG = "__plugin__";

/**
 * Build a TRANSIENT WorkspaceMcpManager for plugin-declared MCP servers (spec §6.4/§16.7).
 *
 * Independent of the getWorkspaceMcpManager() singleton — plugin servers never pollute the
 * workspace MCP pool. Server ids are namespaced `${pluginId}:${serverId}` to avoid cross-plugin
 * collisions (two plugins declaring "github"). Lifecycle: caller must disposeWorkspace on
 * session end (§16.7: plugin MCP stops on session shutdown).
 *
 * Reuses WorkspaceMcpManager + McpClientManager unchanged (same StdioClientTransport/HTTP/SSE
 * spawn, retry, tool enumeration). No §8.1 gating here (Merge-B).
 */
export function buildPluginMcpManager(servers: ResolvedMcpServer[]): WorkspaceMcpManager {
  const namespaced: WorkspaceMcpConfig = { servers: {} };
  for (const server of servers) {
    const id = `${server.pluginId}:${server.serverId}`;
    namespaced.servers[id] = server.entry as McpServerEntry;
  }
  return new WorkspaceMcpManager({ readConfig: () => namespaced });
}
