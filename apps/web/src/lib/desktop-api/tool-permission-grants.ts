import { AGENT_IPC_CHANNELS } from '@lume/shared'
import type { AgentToolPermissionGrantRecord } from '@lume/shared'
import { sidecarCall } from './system'

/** workspace 级持久工具授权查看/撤销（#775） */
export const listToolPermissionGrants = () =>
  sidecarCall<{ grants: AgentToolPermissionGrantRecord[] }>(AGENT_IPC_CHANNELS.LIST_TOOL_PERMISSION_GRANTS, {})

export const revokeToolPermissionGrants = (input: { ids?: string[]; workspaceSlug?: string }) =>
  sidecarCall<{ removed: number }>(AGENT_IPC_CHANNELS.REVOKE_TOOL_PERMISSION_GRANT, input)
