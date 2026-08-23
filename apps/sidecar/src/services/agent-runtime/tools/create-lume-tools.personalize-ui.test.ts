import { registerRealAgentStores } from "../agent-thread-store-test-adapter";
registerRealAgentStores();
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import { getPersistedGeneralSettings } from "../../system/general-settings-service";
import { getPersistedUiState } from "../../system/ui-state-service";
import { createLumeRuntimeTools } from "./create-lume-tools";

function createTools(threadId = "thread-1"): ToolDefinition[] {
  return createLumeRuntimeTools({
    threadId,
    includeCitations: false,
    emitAskUserQuestion: () => {},
    emitToolPermissionRequest: () => {}
  }).customTools;
}

function resolveTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`工具不存在: ${name}`);
  }
  return tool;
}

async function callTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const result = await tool.call(input, { cwd: process.cwd(), abortSignal: new AbortController().signal });
  const maybeData = result as { data?: unknown; content?: unknown };
  if (maybeData.data !== undefined) return maybeData.data as Record<string, unknown>;
  return JSON.parse(String(maybeData.content)) as Record<string, unknown>;
}

describe("createLumeRuntimeTools personalize_ui", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-personalize-ui-tool-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("exposes a real personalize_ui tool for supported persisted appearance state", async () => {
    const tool = resolveTool(createTools("thread-1"), "personalize_ui");

    await expect(callTool(tool, { action: "read" })).resolves.toMatchObject({
      ok: true,
      supportedFields: ["themeMode", "themePalette", "customThemePalettes", "activeView", "promptSidebarOpen", "sidePanelOpen"],
      generalSettings: { themeMode: "system" },
      uiState: { activeView: "conversations", promptSidebarOpen: false }
    });

    const updated = await callTool(tool, {
      action: "update",
      themeMode: "dark",
      activeView: "settings",
      promptSidebarOpen: true,
      sidePanelOpen: true
    });

    expect(updated).toMatchObject({
      ok: true,
      generalSettings: { themeMode: "dark" },
      uiState: {
        activeView: "settings",
        promptSidebarOpen: true,
        agentSidePanelOpenByThreadId: { "thread-1": true }
      }
    });
    expect(getPersistedGeneralSettings().themeMode).toBe("dark");
    expect(getPersistedUiState().agentSidePanelOpenByThreadId["thread-1"]).toBe(true);
  });

  test("creates, activates, and deletes a custom theme", async () => {
    const tool = resolveTool(createTools("thread-1"), "personalize_ui");
    const customTheme = {
      id: "custom:quiet-forest",
      name: "静谧森林",
      light: {
        background: "#f7faf7",
        surface: "#ffffff",
        text: "#1f2a22",
        muted: "#6f7f73",
        accent: "#3f7d58"
      },
      dark: {
        background: "#111713",
        surface: "#1c261f",
        text: "#eef7f0",
        muted: "#91a697",
        accent: "#76c893"
      }
    };

    const created = await callTool(tool, { action: "upsert_theme", customTheme });
    expect(created).toMatchObject({
      ok: true,
      generalSettings: {
        themePalette: customTheme.id,
        customThemePalettes: [customTheme]
      }
    });

    const deleted = await callTool(tool, { action: "delete_theme", themeId: customTheme.id });
    expect(deleted).toMatchObject({
      ok: true,
      generalSettings: { themePalette: "mint", customThemePalettes: [] }
    });
  });
});
