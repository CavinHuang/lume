import { AGENT_IPC_CHANNELS } from '@lume/shared'
import type {
  CallMcpToolDiagnosticRequest,
  CallMcpToolDiagnosticResponse,
  GetMcpStatusResponse,
  ListMcpResourcesRequest,
  ListMcpResourcesResponse,
  ReadMcpResourceRequest,
  ReadMcpResourceResponse,
  TestMcpServerResponse,
  WorkspaceMcpConfig,
} from '@lume/shared'
import { sidecarCall } from './system'

export const getMcpConfig = (workspaceSlug: string) =>
  sidecarCall<WorkspaceMcpConfig>(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, { workspaceSlug })

export const saveMcpConfig = (workspaceSlug: string, config: WorkspaceMcpConfig) =>
  sidecarCall<{ ok: true }>(AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG, { workspaceSlug, config })

export const getMcpStatus = (workspaceSlug: string) =>
  sidecarCall<GetMcpStatusResponse>(AGENT_IPC_CHANNELS.GET_MCP_STATUS, { workspaceSlug })

export const testMcpServer = (workspaceSlug: string, serverId: string) =>
  sidecarCall<TestMcpServerResponse>(AGENT_IPC_CHANNELS.TEST_MCP_SERVER, { workspaceSlug, serverId })

export const listMcpResources = (input: ListMcpResourcesRequest) =>
  sidecarCall<ListMcpResourcesResponse>(AGENT_IPC_CHANNELS.LIST_MCP_RESOURCES, input)

export const readMcpResource = (input: ReadMcpResourceRequest) =>
  sidecarCall<ReadMcpResourceResponse>(AGENT_IPC_CHANNELS.READ_MCP_RESOURCE, input)

export const callMcpToolDiagnostic = (input: CallMcpToolDiagnosticRequest) =>
  sidecarCall<CallMcpToolDiagnosticResponse>(AGENT_IPC_CHANNELS.CALL_MCP_TOOL, input)
