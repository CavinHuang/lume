import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettingsPath } from "../infra/config-paths";
import { getPersistedUiState, updatePersistedUiState } from "./ui-state-service";

describe("ui-state-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-ui-state-test-"));
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

  test("空 settings 时应返回默认 UI 状态", () => {
    expect(getPersistedUiState()).toEqual({
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
    });
  });

  test("更新 UI 状态时应保留其他 settings 字段并原子写入", () => {
    const settingsPath = getSettingsPath();
    writeFileSync(settingsPath, JSON.stringify({ proxy: { enabled: true } }, null, 2), "utf-8");

    const result = updatePersistedUiState({
      appMode: "agent",
      activeView: "settings",
      currentAgentThreadId: "thread-1",
      currentAgentWorkspaceId: "workspace-1",
      promptSidebarOpen: true,
      agentSidePanelOpenByThreadId: {
        "thread-1": false
      },
      chatDraftByConversationId: {
        "conversation-1": "draft chat"
      },
      agentDraftByThreadId: {
        "thread-1": "draft agent"
      }
    });

    expect(result.appMode).toBe("agent");
    expect(result.activeView).toBe("settings");
    expect(result.currentAgentThreadId).toBe("thread-1");
    expect(result.currentAgentWorkspaceId).toBe("workspace-1");
    expect(result.promptSidebarOpen).toBeTrue();
    expect(result.agentSidePanelOpenByThreadId["thread-1"]).toBeFalse();
    expect(result.chatDraftByConversationId["conversation-1"]).toBe("draft chat");
    expect(result.agentDraftByThreadId["thread-1"]).toBe("draft agent");
    expect(result.updatedAt).toBeGreaterThan(0);

    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      proxy?: { enabled?: boolean };
      uiState?: { currentAgentThreadId?: string };
    };
    expect(raw.proxy?.enabled).toBeTrue();
    expect(raw.uiState?.currentAgentThreadId).toBe("thread-1");
    expect(existsSync(join(tempConfigDir, "settings.json.tmp"))).toBeFalse();
    expect(existsSync(join(tempConfigDir, "settings.json.bak"))).toBeFalse();
  });
});
