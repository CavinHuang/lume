import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PersistedUiState, UpdateUiStateInput } from "@lume/shared";
import { getSettingsPath } from "../infra/config-paths";

interface SidecarSettings {
  uiState?: PersistedUiState;
  [key: string]: unknown;
}

const DEFAULT_UI_STATE: PersistedUiState = {
  version: 1,
  appMode: "chat",
  activeView: "conversations",
  currentConversationId: null,
  currentAgentThreadId: null,
  currentAgentWorkspaceId: null,
  promptSidebarOpen: false,
  agentSidePanelOpenByThreadId: {},
  chatDraftByConversationId: {},
  agentDraftByThreadId: {},
  updatedAt: 0
};

function readSettings(): SidecarSettings {
  const path = getSettingsPath();
  if (!existsSync(path)) {
    return {};
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as SidecarSettings;
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch (error) {
    console.warn("[UI State] 读取 settings.json 失败，回退默认值:", error);
    return {};
  }
}

function writeSettings(settings: SidecarSettings): void {
  const path = getSettingsPath();
  const tempPath = join(dirname(path), "settings.json.tmp");
  const backupPath = join(dirname(path), "settings.json.bak");
  writeFileSync(tempPath, JSON.stringify(settings, null, 2), "utf-8");
  if (existsSync(path)) {
    rmSync(backupPath, { force: true });
    renameSync(path, backupPath);
  }
  try {
    renameSync(tempPath, path);
    rmSync(backupPath, { force: true });
  } catch (error) {
    if (existsSync(backupPath)) {
      renameSync(backupPath, path);
    }
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true });
    }
    throw error;
  }
}

function sanitizeUiState(input: unknown): PersistedUiState {
  if (typeof input !== "object" || input === null) {
    return DEFAULT_UI_STATE;
  }

  const value = input as Partial<PersistedUiState>;
  return {
    version: 1,
    appMode: value.appMode === "agent" ? "agent" : "chat",
    activeView: value.activeView === "settings" ? "settings" : "conversations",
    currentConversationId: typeof value.currentConversationId === "string" ? value.currentConversationId : null,
    currentAgentThreadId: typeof value.currentAgentThreadId === "string" ? value.currentAgentThreadId : null,
    currentAgentWorkspaceId: typeof value.currentAgentWorkspaceId === "string" ? value.currentAgentWorkspaceId : null,
    promptSidebarOpen: value.promptSidebarOpen === true,
    agentSidePanelOpenByThreadId: sanitizeSidePanelOpenMap(value.agentSidePanelOpenByThreadId),
    chatDraftByConversationId: sanitizeStringMap(value.chatDraftByConversationId),
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
  const settings = readSettings();
  return sanitizeUiState(settings.uiState);
}

export function updatePersistedUiState(input: UpdateUiStateInput): PersistedUiState {
  const settings = readSettings();
  const current = sanitizeUiState(settings.uiState);
  const next: PersistedUiState = {
    ...current,
    ...input,
    version: 1,
    updatedAt: Date.now()
  };
  settings.uiState = next;
  writeSettings(settings);
  return next;
}
