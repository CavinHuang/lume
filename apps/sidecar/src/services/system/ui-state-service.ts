import type { PersistedUiState, UpdateUiStateInput } from "@lume/shared";
import {
  PersistedSettingsReadError,
  readPersistedSettings,
  writePersistedSettings,
  type SidecarSettingsStore
} from "./settings-store";

interface SidecarSettings extends SidecarSettingsStore {
  uiState?: PersistedUiState;
}

const DEFAULT_UI_STATE: PersistedUiState = {
  version: 1,
  activeView: "conversations",
  currentAgentThreadId: null,
  currentAgentWorkspaceId: null,
  promptSidebarOpen: false,
  agentSidePanelOpenByThreadId: {},
  agentDraftByThreadId: {},
  updatedAt: 0
};

function sanitizeUiState(input: unknown): PersistedUiState {
  if (typeof input !== "object" || input === null) {
    return DEFAULT_UI_STATE;
  }

  const value = input as Partial<PersistedUiState>;
  return {
    version: 1,
    activeView: value.activeView === "settings" ? "settings" : "conversations",
    currentAgentThreadId: typeof value.currentAgentThreadId === "string" ? value.currentAgentThreadId : null,
    currentAgentWorkspaceId: typeof value.currentAgentWorkspaceId === "string" ? value.currentAgentWorkspaceId : null,
    promptSidebarOpen: value.promptSidebarOpen === true,
    agentSidePanelOpenByThreadId: sanitizeSidePanelOpenMap(value.agentSidePanelOpenByThreadId),
    agentDraftByThreadId: sanitizeStringMap(value.agentDraftByThreadId),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0
  };
}

function sanitizeSidePanelOpenMap(input: unknown): Record<string, boolean> {
  if (typeof input !== "object" || input === null) {
    return {};
  }

  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof key === "string" && typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function sanitizeStringMap(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof key === "string" && typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

export function getPersistedUiState(): PersistedUiState {
  try {
    const settings = readPersistedSettings() as SidecarSettings;
    return sanitizeUiState(settings.uiState);
  } catch (error) {
    if (error instanceof PersistedSettingsReadError) {
      console.warn("[UI State] 读取 settings.json 失败，回退默认值:", error.cause ?? error);
      return DEFAULT_UI_STATE;
    }
    throw error;
  }
}

export function updatePersistedUiState(input: UpdateUiStateInput): PersistedUiState {
  const settings = readPersistedSettings() as SidecarSettings;
  const current = sanitizeUiState(settings.uiState);
  const next: PersistedUiState = {
    ...current,
    ...input,
    version: 1,
    updatedAt: Date.now()
  };
  settings.uiState = next;
  writePersistedSettings(settings);
  return next;
}
