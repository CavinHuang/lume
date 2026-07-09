import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
      agentMessageDisplayMode: "minimal",
      windowBehavior: {
        minimizeToTray: false,
        closeToTray: false,
        showTray: true
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
      agentMessageDisplayMode: "minimal",
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: false,
        showTray: true
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
      agentMessageDisplayMode: "minimal",
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: true,
        showTray: true
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
        agentMessageDisplayMode?: string;
        windowBehavior?: {
          minimizeToTray?: boolean;
          closeToTray?: boolean;
          showTray?: boolean;
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
      agentMessageDisplayMode: "minimal",
      windowBehavior: {
        minimizeToTray: true,
        closeToTray: true,
        showTray: true
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
        activeView: "settings",
        currentAgentThreadId: "thread-1",
        currentAgentWorkspaceId: "workspace-1",
        promptSidebarOpen: true,
        agentSidePanelOpenByThreadId: {
          "thread-1": true
        },
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
        currentAgentThreadId?: string;
        updatedAt?: number;
      };
      generalSettings?: {
        themeMode?: string;
      };
    };

    expect(raw.uiState).toMatchObject({
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
      agentMessageDisplayMode: "minimal",
      windowBehavior: {
        minimizeToTray: false,
        closeToTray: false,
        showTray: true
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

  test("vectorIndex 清理全局 memory/index", () => {
    mkdirSync(join(tempConfigDir, "memory", "index"), { recursive: true });
    const indexFile = join(tempConfigDir, "memory", "index", "vector-index.json");
    writeFileSync(indexFile, "{}", "utf-8");

    const result = clearGeneralSettingsCaches({ vectorIndex: true });

    expect(result.cleared).toContain("vectorIndex");
    expect(existsSync(indexFile)).toBeFalse();
  });

  test("pluginsCache 清理 plugins/cache 与 plugins/data", () => {
    const cacheFile = writeConfigFile(["plugins", "cache", "p.json"], "{}");
    const dataFile = writeConfigFile(["plugins", "data", "p.json"], "{}");

    const result = clearGeneralSettingsCaches({ pluginsCache: true });

    expect(result.cleared).toContain("pluginsCache");
    expect(existsSync(cacheFile)).toBeFalse();
    expect(existsSync(dataFile)).toBeFalse();
  });

  test("vectorIndex 清理每个工作区的 memory/index 且保留非索引文件", async () => {
    const { clearGeneralSettingsCaches } = await import("./general-settings-service");
    const root = process.env.LUME_CONFIG_DIR!;
    mkdirSync(join(root, "agent-workspaces", "ws-a", "memory", "index"), { recursive: true });
    writeFileSync(join(root, "agent-workspaces", "ws-a", "memory", "index", "vec.json"), "{}");
    mkdirSync(join(root, "agent-workspaces", "ws-a", "memory", "entries"), { recursive: true });
    writeFileSync(join(root, "agent-workspaces", "ws-a", "memory", "MEMORY.md"), "keep");
    mkdirSync(join(root, "agent-workspaces", "ws-b", "memory", "index"), { recursive: true });
    writeFileSync(join(root, "agent-workspaces", "ws-b", "memory", "index", "vec.json"), "{}");

    const result = clearGeneralSettingsCaches({ vectorIndex: true });

    expect(result.cleared).toContain("vectorIndex");
    expect(() => statSync(join(root, "agent-workspaces", "ws-a", "memory", "index", "vec.json"))).toThrow();
    expect(() => statSync(join(root, "agent-workspaces", "ws-b", "memory", "index", "vec.json"))).toThrow();
    // 非索引文件必须保留
    expect(statSync(join(root, "agent-workspaces", "ws-a", "memory", "MEMORY.md")).size).toBeGreaterThan(0);
  });

  test("vectorIndex 拒绝清理符号链接逃逸到 ~/.lume 外的目标", async () => {
    const { clearGeneralSettingsCaches } = await import("./general-settings-service");
    const root = process.env.LUME_CONFIG_DIR!;
    // 在 ~/.lume 外造一个受害者目录，含 memory/index
    const victim = mkdtempSync(join(tmpdir(), "lume-victim-"));
    mkdirSync(join(victim, "memory", "index"), { recursive: true });
    writeFileSync(join(victim, "memory", "index", "secret.json"), "leak");
    // 在 agent-workspaces 下放一个符号链接指向受害者
    mkdirSync(join(root, "agent-workspaces"), { recursive: true });
    symlinkSync(victim, join(root, "agent-workspaces", "escape"));

    // 不应抛出；受害者文件必须存活
    const result = clearGeneralSettingsCaches({ vectorIndex: true });
    expect(statSync(join(victim, "memory", "index", "secret.json")).size).toBeGreaterThan(0);
    rmSync(victim, { recursive: true, force: true });
  });

  test("未选中的键不清理", () => {
    const logsFile = writeConfigFile(["logs", "lume.ndjson"], "{}\n");

    const result = clearGeneralSettingsCaches({});

    expect(result.cleared).toEqual([]);
    expect(existsSync(logsFile)).toBeTrue();
  });

  test("agentMessageDisplayMode 缺失时回退 minimal，显式值被保留并持久化", () => {
    const settingsPath = getSettingsPath();
    writeFileSync(
      settingsPath,
      JSON.stringify({ generalSettings: { themeMode: "dark" } }, null, 2),
      "utf-8",
    );

    const loaded = getPersistedGeneralSettings();
    expect(loaded.agentMessageDisplayMode).toBe("minimal");

    const updated = updatePersistedGeneralSettings({ agentMessageDisplayMode: "verbose" });
    expect(updated.agentMessageDisplayMode).toBe("verbose");

    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      generalSettings?: { agentMessageDisplayMode?: string };
    };
    expect(raw.generalSettings?.agentMessageDisplayMode).toBe("verbose");
  });

  function writeConfigFile(pathSegments: string[], content: string): string {
    const fullPath = join(tempConfigDir, ...pathSegments);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
    return fullPath;
  }
});
