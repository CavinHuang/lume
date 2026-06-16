import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  GENERAL_SETTINGS_DEFAULTS,
  type AgentMessageDisplayMode,
  type GeneralSettings,
  type PersistedUiState,
  type ThemeMode,
  type UpdateGeneralSettingsInput
} from "@lume/shared";
import {
  getConfigDir,
  getPluginsCacheDir,
  getPluginsDataDir,
  getGlobalVectorIndexDir,
  getAgentWorkspacesDir
} from "../infra/config-paths";
import {
  PersistedSettingsReadError,
  readPersistedSettings,
  writePersistedSettings,
  type SidecarSettingsStore
} from "./settings-store";

interface SidecarSettings extends SidecarSettingsStore {
  uiState?: PersistedUiState;
  generalSettings?: GeneralSettings;
}

type SidecarCacheCleanupKey = "logs" | "vectorIndex" | "pluginsCache";

export interface SidecarClearCacheInput {
  logs?: boolean;
  vectorIndex?: boolean;
  pluginsCache?: boolean;
}

export interface SidecarClearCacheResult {
  cleared: SidecarCacheCleanupKey[];
  skipped: SidecarCacheCleanupKey[];
}

const CACHE_KEYS: SidecarCacheCleanupKey[] = ["logs", "vectorIndex", "pluginsCache"];

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function isAgentMessageDisplayMode(value: unknown): value is AgentMessageDisplayMode {
  return value === "minimal" || value === "verbose";
}

function sanitizeGeneralSettings(input: unknown): GeneralSettings {
  if (typeof input !== "object" || input === null) {
    return {
      ...GENERAL_SETTINGS_DEFAULTS,
      windowBehavior: { ...GENERAL_SETTINGS_DEFAULTS.windowBehavior },
      updateSettings: { ...GENERAL_SETTINGS_DEFAULTS.updateSettings }
    };
  }

  const value = input as Partial<GeneralSettings>;
  const windowBehavior =
    typeof value.windowBehavior === "object" && value.windowBehavior !== null
      ? value.windowBehavior
      : undefined;
  const updateSettings =
    typeof value.updateSettings === "object" && value.updateSettings !== null
      ? value.updateSettings
      : undefined;

  return {
    themeMode: isThemeMode(value.themeMode) ? value.themeMode : GENERAL_SETTINGS_DEFAULTS.themeMode,
    agentMessageDisplayMode: isAgentMessageDisplayMode(value.agentMessageDisplayMode)
      ? value.agentMessageDisplayMode
      : GENERAL_SETTINGS_DEFAULTS.agentMessageDisplayMode,
    windowBehavior: {
      minimizeToTray:
        typeof windowBehavior?.minimizeToTray === "boolean"
          ? windowBehavior.minimizeToTray
          : GENERAL_SETTINGS_DEFAULTS.windowBehavior.minimizeToTray,
      closeToTray:
        typeof windowBehavior?.closeToTray === "boolean"
          ? windowBehavior.closeToTray
          : GENERAL_SETTINGS_DEFAULTS.windowBehavior.closeToTray
    },
    updateSettings: {
      autoCheckUpdates:
        typeof updateSettings?.autoCheckUpdates === "boolean"
          ? updateSettings.autoCheckUpdates
          : GENERAL_SETTINGS_DEFAULTS.updateSettings.autoCheckUpdates,
      notifyAfterDownload:
        typeof updateSettings?.notifyAfterDownload === "boolean"
          ? updateSettings.notifyAfterDownload
          : GENERAL_SETTINGS_DEFAULTS.updateSettings.notifyAfterDownload,
      installOnlyWhenIdle:
        typeof updateSettings?.installOnlyWhenIdle === "boolean"
          ? updateSettings.installOnlyWhenIdle
          : GENERAL_SETTINGS_DEFAULTS.updateSettings.installOnlyWhenIdle,
      lastUpdateCheckAt:
        typeof updateSettings?.lastUpdateCheckAt === "string"
          ? updateSettings.lastUpdateCheckAt
          : null
    }
  };
}

/** Resolve a path following symlinks; fall back to lexical resolve if the path doesn't exist. */
function safeRealpath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

function resolveCacheTargetPaths(key: SidecarCacheCleanupKey): string[] {
  const configDir = getConfigDir();
  switch (key) {
    case "logs":
      return Array.from(new Set([
        join(configDir, "logs"),
        join(tmpdir(), "lume-logs")
      ]));
    case "vectorIndex": {
      const paths = [getGlobalVectorIndexDir()];
      try {
        const workspacesDir = getAgentWorkspacesDir();
        for (const slug of readdirSync(workspacesDir)) {
          paths.push(join(workspacesDir, slug, "memory", "index"));
        }
      } catch {
        // 工作区目录不存在时忽略
      }
      return paths;
    }
    case "pluginsCache":
      return [getPluginsCacheDir(), getPluginsDataDir()];
  }
}

function assertSafeCacheTarget(targetPath: string): void {
  const configDir = getConfigDir();
  const allowedRoots = [
    join(configDir, "cache"),
    join(configDir, "logs"),
    join(configDir, "memory", "index"),
    join(configDir, "plugins", "cache"),
    join(configDir, "plugins", "data"),
    join(configDir, "agent-workspaces"),
    join(tmpdir(), "lume-logs")
  ].map((value) => safeRealpath(value));
  const resolvedTarget = safeRealpath(targetPath);
  const isAllowed = allowedRoots.some((root) =>
    resolvedTarget === root || resolvedTarget.startsWith(`${root}${sep}`)
  );
  if (!isAllowed) {
    throw new Error(`Refusing to clear unsafe cache target: ${targetPath}`);
  }
}

function clearDirectoryContents(targetPath: string): boolean {
  if (!existsSync(targetPath)) {
    return false;
  }

  try {
    assertSafeCacheTarget(targetPath);
  } catch {
    return false;
  }

  const stat = lstatSync(targetPath);
  if (!stat.isDirectory()) {
    rmSync(targetPath, { force: true, recursive: true });
    return true;
  }

  for (const child of readdirSync(targetPath)) {
    rmSync(join(targetPath, child), { force: true, recursive: true });
  }
  return true;
}

export function getPersistedGeneralSettings(): GeneralSettings {
  try {
    const settings = readPersistedSettings() as SidecarSettings;
    return sanitizeGeneralSettings(settings.generalSettings);
  } catch (error) {
    if (error instanceof PersistedSettingsReadError) {
      console.warn("[General Settings] 读取 settings.json 失败，回退默认值:", error.cause ?? error);
      return {
        ...GENERAL_SETTINGS_DEFAULTS,
        windowBehavior: { ...GENERAL_SETTINGS_DEFAULTS.windowBehavior },
        updateSettings: { ...GENERAL_SETTINGS_DEFAULTS.updateSettings }
      };
    }
    throw error;
  }
}

export function updatePersistedGeneralSettings(input: UpdateGeneralSettingsInput): GeneralSettings {
  const settings = readPersistedSettings() as SidecarSettings;
  const current = sanitizeGeneralSettings(settings.generalSettings);
  const next: GeneralSettings = {
    themeMode: input.themeMode ?? current.themeMode,
    agentMessageDisplayMode: input.agentMessageDisplayMode ?? current.agentMessageDisplayMode,
    windowBehavior: {
      minimizeToTray: input.windowBehavior?.minimizeToTray ?? current.windowBehavior.minimizeToTray,
      closeToTray: input.windowBehavior?.closeToTray ?? current.windowBehavior.closeToTray
    },
    updateSettings: {
      autoCheckUpdates: input.updateSettings?.autoCheckUpdates ?? current.updateSettings.autoCheckUpdates,
      notifyAfterDownload: input.updateSettings?.notifyAfterDownload ?? current.updateSettings.notifyAfterDownload,
      installOnlyWhenIdle: input.updateSettings?.installOnlyWhenIdle ?? current.updateSettings.installOnlyWhenIdle,
      lastUpdateCheckAt:
        input.updateSettings && "lastUpdateCheckAt" in input.updateSettings
          ? input.updateSettings.lastUpdateCheckAt ?? null
          : current.updateSettings.lastUpdateCheckAt
    }
  };
  settings.generalSettings = next;
  writePersistedSettings(settings);
  return next;
}

export function clearGeneralSettingsCaches(input: SidecarClearCacheInput): SidecarClearCacheResult {
  const result: SidecarClearCacheResult = {
    cleared: [],
    skipped: []
  };

  for (const key of CACHE_KEYS) {
    if (input[key] !== true) {
      continue;
    }

    const touched = resolveCacheTargetPaths(key)
      .map((targetPath) => clearDirectoryContents(targetPath))
      .some(Boolean);

    if (touched) {
      result.cleared.push(key);
    } else {
      result.skipped.push(key);
    }
  }

  return result;
}
