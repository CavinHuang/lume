export interface PersistedUiState {
  version: 1
  appMode: "chat" | "agent"
  activeView: "conversations" | "settings"
  currentConversationId: string | null
  currentAgentThreadId: string | null
  currentAgentWorkspaceId: string | null
  promptSidebarOpen: boolean
  agentSidePanelOpenByThreadId: Record<string, boolean>
  chatDraftByConversationId: Record<string, string>
  agentDraftByThreadId: Record<string, string>
  updatedAt: number
}

export interface UpdateUiStateInput {
  appMode?: "chat" | "agent"
  activeView?: "conversations" | "settings"
  currentConversationId?: string | null
  currentAgentThreadId?: string | null
  currentAgentWorkspaceId?: string | null
  promptSidebarOpen?: boolean
  agentSidePanelOpenByThreadId?: Record<string, boolean>
  chatDraftByConversationId?: Record<string, string>
  agentDraftByThreadId?: Record<string, string>
}

export const UI_STATE_IPC_CHANNELS = {
  GET: "ui-state:get",
  UPDATE: "ui-state:update"
} as const
