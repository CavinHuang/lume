export interface PersistedUiState {
  version: 1
  activeView: "conversations" | "settings"
  currentAgentThreadId: string | null
  currentAgentWorkspaceId: string | null
  promptSidebarOpen: boolean
  agentSidePanelOpenByThreadId: Record<string, boolean>
  agentDraftByThreadId: Record<string, string>
  updatedAt: number
}

export interface UpdateUiStateInput {
  activeView?: "conversations" | "settings"
  currentAgentThreadId?: string | null
  currentAgentWorkspaceId?: string | null
  promptSidebarOpen?: boolean
  agentSidePanelOpenByThreadId?: Record<string, boolean>
  agentDraftByThreadId?: Record<string, string>
}
