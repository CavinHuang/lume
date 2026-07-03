import type { McpServerStatus } from "@lume/shared";
import { getNodeReplMcpStatus, NODE_REPL_MCP_SERVER_ID } from "../agent-runtime/tools/node-repl/create-node-repl-tools";

export function appendBuiltinMcpStatuses(statuses: McpServerStatus[], now = Date.now()): McpServerStatus[] {
  const withoutBuiltin = statuses.filter((status) => status.serverId !== NODE_REPL_MCP_SERVER_ID);
  return [...withoutBuiltin, getNodeReplMcpStatus(now)];
}
