import type { ToolDefinition } from "@lume/agent-sdk";
import type {
  CustomThemePalette,
  CustomThemePaletteColors,
  ThemeMode,
  ThemePalette
} from "@lume/shared";
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
  "themePalette",
  "customThemePalettes",
  "activeView",
  "promptSidebarOpen",
  "sidePanelOpen"
];

function optionalThemeMode(value: unknown): ThemeMode | undefined {
  return value === "system" || value === "light" || value === "dark" ? value : undefined;
}

function isBuiltInThemePalette(value: unknown): value is ThemePalette {
  return value === "mint" || value === "iris" || value === "clay" || value === "ocean"
    || value === "sakura" || value === "ember" || value === "mono"
    || value === "lavender" || value === "olive";
}

function optionalThemePalette(value: unknown): ThemePalette | undefined {
  if (isBuiltInThemePalette(value)) return value;
  if (typeof value !== "string" || !/^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(value)) return undefined;
  return getPersistedGeneralSettings().customThemePalettes.some((theme) => theme.id === value)
    ? value as ThemePalette
    : undefined;
}

function readCustomThemeColors(value: unknown): CustomThemePaletteColors {
  if (!value || typeof value !== "object") throw new Error("自定义主题必须同时提供 light 和 dark 配色");
  const colors = value as Record<string, unknown>;
  for (const key of ["background", "surface", "text", "muted", "accent"] as const) {
    if (typeof colors[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(colors[key])) {
      throw new Error(`自定义主题颜色 ${key} 必须是 #RRGGBB`);
    }
  }
  return colors as unknown as CustomThemePaletteColors;
}

function readCustomTheme(value: unknown): CustomThemePalette {
  if (!value || typeof value !== "object") throw new Error("customTheme 不能为空");
  const theme = value as Record<string, unknown>;
  if (typeof theme.id !== "string" || !/^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(theme.id)) {
    throw new Error("customTheme.id 必须使用 custom: 前缀和小写短横线格式");
  }
  if (typeof theme.name !== "string" || !theme.name.trim() || theme.name.trim().length > 32) {
    throw new Error("customTheme.name 必须为 1 到 32 个字符");
  }
  return {
    id: theme.id as CustomThemePalette["id"],
    name: theme.name.trim(),
    light: readCustomThemeColors(theme.light),
    dark: readCustomThemeColors(theme.dark)
  };
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
      "Read or update Lume UI preferences, including creating, activating, and deleting custom light/dark color themes.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "update", "upsert_theme", "delete_theme"] },
        themeMode: { type: "string", enum: ["system", "light", "dark"] },
        themePalette: { type: "string", description: "Built-in palette ID or an existing custom:* theme ID" },
        themeId: { type: "string", pattern: "^custom:[a-z0-9][a-z0-9-]{0,47}$" },
        customTheme: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^custom:[a-z0-9][a-z0-9-]{0,47}$" },
            name: { type: "string", minLength: 1, maxLength: 32 },
            light: {
              type: "object",
              properties: {
                background: { type: "string" }, surface: { type: "string" }, text: { type: "string" },
                muted: { type: "string" }, accent: { type: "string" }
              },
              required: ["background", "surface", "text", "muted", "accent"]
            },
            dark: {
              type: "object",
              properties: {
                background: { type: "string" }, surface: { type: "string" }, text: { type: "string" },
                muted: { type: "string" }, accent: { type: "string" }
              },
              required: ["background", "surface", "text", "muted", "accent"]
            }
          },
          required: ["id", "name", "light", "dark"]
        },
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
      if (action === "upsert_theme") {
        const customTheme = readCustomTheme(args.customTheme);
        const current = getPersistedGeneralSettings();
        const existingIndex = current.customThemePalettes.findIndex((theme) => theme.id === customTheme.id);
        const customThemePalettes = existingIndex === -1
          ? [...current.customThemePalettes, customTheme]
          : current.customThemePalettes.map((theme) => theme.id === customTheme.id ? customTheme : theme);
        const saved = await updatePersistedGeneralSettings({ customThemePalettes, themePalette: customTheme.id });
        if (!saved.customThemePalettes.some((theme) => theme.id === customTheme.id)) {
          throw new Error("自定义主题数量已达到上限 12 个");
        }
        return { ok: true, action, ...snapshot() };
      }
      if (action === "delete_theme") {
        const themeId = typeof args.themeId === "string" ? args.themeId : "";
        if (!/^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(themeId)) {
          throw new Error("themeId 必须是有效的 custom:* 主题 ID");
        }
        const current = getPersistedGeneralSettings();
        await updatePersistedGeneralSettings({
          customThemePalettes: current.customThemePalettes.filter((theme) => theme.id !== themeId),
          ...(current.themePalette === themeId ? { themePalette: "mint" } : {})
        });
        return { ok: true, action, ...snapshot() };
      }
      if (action !== "update") {
        throw new Error("personalize_ui.action 不受支持");
      }

      const themeMode = optionalThemeMode(args.themeMode);
      const themePalette = optionalThemePalette(args.themePalette);
      if (themeMode || themePalette) {
        await updatePersistedGeneralSettings({
          ...(themeMode ? { themeMode } : {}),
          ...(themePalette ? { themePalette } : {})
        });
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
