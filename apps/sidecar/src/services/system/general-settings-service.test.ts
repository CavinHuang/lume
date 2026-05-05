import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSettingsPath } from "../infra/config-paths";
import {
  clearGeneralSettingsCaches,
  getPersistedGeneralSettings,
  updatePersistedGeneralSettings
} from "./general-settings-service";

describe("general-settings-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-general-settings-test-"));
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

  test("缺少 settings.json 时返回默认常规设置", () => {
    expect(getPersistedGeneralSettings()).toEqual({
      themeMode: "system",
      userProfile: {
        displayName: ""
      },
      windowBehavior: {
        minimizeToTray: false,
        closeToTray: false
      },
      updateSettings: {
        autoCheckUpdates: true,
        notifyAfterDownload: true,
        installOnlyWhenIdle: true,
        lastUpdateCheckAt: null
      }
    });
  });

  test("更新常规设置时合并 themeMode 与 windowBehavior 并保留同级字段", () => {
    const settingsPath = getSettingsPath();
    writeFileSync(settingsPath, JSON.stringify({ proxy: { enabled: true } }, null, 2), "utf-8");

    const first = updatePersistedGeneralSettings({
      themeMode: "dark",
      windowBehavior: {
        minimizeToTray: true
      }
    });

    expect(first).toEqual({
      themeMode: "dark",
      userProfile: {
        displayName: ""
      },
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: false
      },
      updateSettings: {
        autoCheckUpdates: true,
        notifyAfterDownload: true,
        installOnlyWhenIdle: true,
        lastUpdateCheckAt: null
      }
    });

    const second = updatePersistedGeneralSettings({
      windowBehavior: {
        closeToTray: true
      }
    });

    expect(second).toEqual({
      themeMode: "dark",
      userProfile: {
        displayName: ""
      },
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: true
      },
      updateSettings: {
        autoCheckUpdates: true,
        notifyAfterDownload: true,
        installOnlyWhenIdle: true,
        lastUpdateCheckAt: null
      }
    });

    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      proxy?: { enabled?: boolean };
      generalSettings?: {
        themeMode?: string;
        userProfile?: {
          displayName?: string;
        };
        windowBehavior?: {
          minimizeToTray?: boolean;
          closeToTray?: boolean;
        };
        updateSettings?: {
          autoCheckUpdates?: boolean;
          notifyAfterDownload?: boolean;
          installOnlyWhenIdle?: boolean;
          lastUpdateCheckAt?: string | null;
        };
      };
    };
    expect(raw.proxy?.enabled).toBeTrue();
    expect(raw.generalSettings).toEqual({
      themeMode: "dark",
      userProfile: {
        displayName: ""
      },
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: true
      },
      updateSettings: {
        autoCheckUpdates: true,
        notifyAfterDownload: true,
        installOnlyWhenIdle: true,
        lastUpdateCheckAt: null
      }
    });
    expect(existsSync(join(tempConfigDir, "settings.json.tmp"))).toBeFalse();
    expect(existsSync(join(tempConfigDir, "settings.json.bak"))).toBeFalse();
  });

  test("更新 generalSettings 时保留既有 uiState", () => {
    const settingsPath = getSettingsPath();
    writeFileSync(settingsPath, JSON.stringify({
      uiState: {
        version: 1,
        appMode: "agent",
        activeView: "settings",
        currentConversationId: null,
        currentAgentThreadId: "thread-1",
        currentAgentWorkspaceId: "workspace-1",
        promptSidebarOpen: true,
        agentSidePanelOpenByThreadId: {
          "thread-1": true
        },
        chatDraftByConversationId: {},
        agentDraftByThreadId: {
          "thread-1": "draft"
        },
        updatedAt: 123
      }
    }, null, 2), "utf-8");

    updatePersistedGeneralSettings({
      themeMode: "light"
    });

    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      uiState?: {
        appMode?: string;
        currentAgentThreadId?: string;
        updatedAt?: number;
      };
      generalSettings?: {
        themeMode?: string;
      };
    };

    expect(raw.uiState).toMatchObject({
      appMode: "agent",
      currentAgentThreadId: "thread-1",
      updatedAt: 123
    });
    expect(raw.generalSettings?.themeMode).toBe("light");
  });

  test("settings.json 解析失败时读取回退默认值，但写入会显式失败以避免覆盖其他段", () => {
    const settingsPath = getSettingsPath();
    writeFileSync(settingsPath, "{ invalid json", "utf-8");

    expect(getPersistedGeneralSettings()).toEqual({
      themeMode: "system",
      userProfile: {
        displayName: ""
      },
      windowBehavior: {
        minimizeToTray: false,
        closeToTray: false
      },
      updateSettings: {
        autoCheckUpdates: true,
        notifyAfterDownload: true,
        installOnlyWhenIdle: true,
        lastUpdateCheckAt: null
      }
    });

    expect(() => updatePersistedGeneralSettings({
      themeMode: "dark"
    })).toThrow();
    expect(readFileSync(settingsPath, "utf-8")).toBe("{ invalid json");
  });

  test("更新用户名称时应清洗空白并落盘到本地 settings.json", () => {
    const settingsPath = getSettingsPath();

    const result = updatePersistedGeneralSettings({
      userProfile: {
        displayName: "  Minator Huang  "
      }
    });

    expect(result.userProfile.displayName).toBe("Minator Huang");

    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      generalSettings?: {
        userProfile?: {
          displayName?: string;
        };
      };
    };
    expect(raw.generalSettings?.userProfile?.displayName).toBe("Minator Huang");
  });

  test("更新版本偏好时保留未传入的同级选项", () => {
    const first = updatePersistedGeneralSettings({
      updateSettings: {
        autoCheckUpdates: false,
        lastUpdateCheckAt: "2026-05-05T03:00:00.000Z"
      }
    });

    expect(first.updateSettings).toEqual({
      autoCheckUpdates: false,
      notifyAfterDownload: true,
      installOnlyWhenIdle: true,
      lastUpdateCheckAt: "2026-05-05T03:00:00.000Z"
    });

    const second = updatePersistedGeneralSettings({
      updateSettings: {
        notifyAfterDownload: false
      }
    });

    expect(second.updateSettings).toEqual({
      autoCheckUpdates: false,
      notifyAfterDownload: false,
      installOnlyWhenIdle: true,
      lastUpdateCheckAt: "2026-05-05T03:00:00.000Z"
    });
  });

  test("清理缓存仅删除安全缓存目录并保留会话线程工作区与配置", () => {
    const logsFile = writeConfigFile(["logs", "today.log"], "log");
    const conversationFile = writeConfigFile(["conversations", "conversation-1.jsonl"], "conversation");
    const threadFile = writeConfigFile(["agent", "sessions", "thread-1.jsonl"], "thread");
    const workspaceFile = writeConfigFile(["agent-workspaces", "workspace-1", "note.txt"], "workspace");
    const lumeConfigFile = writeConfigFile(["lume.yaml"], "name: lume");
    const channelsFile = writeConfigFile(["channels.json"], "{\"items\":[]}");
    const mcpConfigFile = writeConfigFile(["agent-workspaces", "workspace-1", ".meta", "mcp.json"], "{}");

    const result = clearGeneralSettingsCaches({ logs: true });

    expect(result).toEqual({
      cleared: ["logs"],
      skipped: []
    });
    expect(existsSync(logsFile)).toBeFalse();
    expect(existsSync(conversationFile)).toBeTrue();
    expect(existsSync(threadFile)).toBeTrue();
    expect(existsSync(workspaceFile)).toBeTrue();
    expect(existsSync(lumeConfigFile)).toBeTrue();
    expect(existsSync(channelsFile)).toBeTrue();
    expect(existsSync(mcpConfigFile)).toBeTrue();
  });

  test("缺失的缓存目标返回 skipped 而不是失败", () => {
    const result = clearGeneralSettingsCaches({ logs: true });

    expect(result).toEqual({
      cleared: [],
      skipped: ["logs"]
    });
  });

  function writeConfigFile(pathSegments: string[], content: string): string {
    const fullPath = join(tempConfigDir, ...pathSegments);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    return fullPath;
  }
});
