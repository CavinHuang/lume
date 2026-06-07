import type { ToolDefinition } from "@lume/agent-sdk";
import type { ThemeMode } from "@lume/shared";
import {
  getPersistedGeneralSettings,
  updatePersistedGeneralSettings
} from "../../../system/general-settings-service";
import {
  getPersistedUiState,
  updatePersistedUiState
} from "../../../system/ui-state-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

const SUPPORTED_FIELDS = [
  "themeMode",
  "activeView",
  "promptSidebarOpen",
  "sidePanelOpen"
];

function optionalThemeMode(value: unknown): ThemeMode | undefined {
  return value === "system" || value === "light" || value === "dark" ? value : undefined;
}

function optionalActiveView(value: unknown): "conversations" | "settings" | undefined {
  return value === "conversations" || value === "settings" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function snapshot() {
  return {
    supportedFields: SUPPORTED_FIELDS,
    generalSettings: getPersistedGeneralSettings(),
    uiState: getPersistedUiState()
  };
}

export function createPersonalizeUiTool(input: { threadId: string }): ToolDefinition {
  return createSdkJsonResultTool({
    name: "personalize_ui",
    description:
      "Read or update supported Lume UI preferences. Supports themeMode, activeView, promptSidebarOpen, and sidePanelOpen for the current thread only.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "update"] },
        themeMode: { type: "string", enum: ["system", "light", "dark"] },
        activeView: { type: "string", enum: ["conversations", "settings"] },
        promptSidebarOpen: { type: "boolean" },
        sidePanelOpen: { type: "boolean" }
      },
      required: ["action"]
    },
    async call(args) {
      const action = typeof args.action === "string" ? args.action : "read";
      if (action === "read") {
        return { ok: true, action, ...snapshot() };
      }
      if (action !== "update") {
        throw new Error("personalize_ui.action 必须是 read 或 update");
      }

      const themeMode = optionalThemeMode(args.themeMode);
      if (themeMode) {
        updatePersistedGeneralSettings({ themeMode });
      }

      const activeView = optionalActiveView(args.activeView);
      const promptSidebarOpen = optionalBoolean(args.promptSidebarOpen);
      const sidePanelOpen = optionalBoolean(args.sidePanelOpen);
      const currentUiState = getPersistedUiState();
      if (activeView || promptSidebarOpen !== undefined || sidePanelOpen !== undefined) {
        updatePersistedUiState({
          ...(activeView ? { activeView } : {}),
          ...(promptSidebarOpen !== undefined ? { promptSidebarOpen } : {}),
          ...(sidePanelOpen !== undefined
            ? {
              agentSidePanelOpenByThreadId: {
                ...currentUiState.agentSidePanelOpenByThreadId,
                [input.threadId]: sidePanelOpen
              }
            }
            : {})
        });
      }

      return { ok: true, action, ...snapshot() };
    }
  });
}
