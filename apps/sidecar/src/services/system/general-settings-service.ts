import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  GENERAL_SETTINGS_DEFAULTS,
  type GeneralSettings,
  type PersistedUiState,
  type ThemeMode,
  type UpdateGeneralSettingsInput
} from "@lume/shared";
import { getConfigDir } from "../infra/config-paths";
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

type SidecarCacheCleanupKey = "logs";

export interface SidecarClearCacheInput {
  logs?: boolean;
}

export interface SidecarClearCacheResult {
  cleared: SidecarCacheCleanupKey[];
  skipped: SidecarCacheCleanupKey[];
}

const CACHE_KEYS: SidecarCacheCleanupKey[] = ["logs"];

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function sanitizeGeneralSettings(input: unknown): GeneralSettings {
  if (typeof input !== "object" || input === null) {
    return {
      ...GENERAL_SETTINGS_DEFAULTS,
      userProfile: { ...GENERAL_SETTINGS_DEFAULTS.userProfile },
      windowBehavior: { ...GENERAL_SETTINGS_DEFAULTS.windowBehavior },
      updateSettings: { ...GENERAL_SETTINGS_DEFAULTS.updateSettings }
    };
  }

  const value = input as Partial<GeneralSettings>;
  const userProfile =
    typeof value.userProfile === "object" && value.userProfile !== null
      ? value.userProfile
      : undefined;
  const windowBehavior =
    typeof value.windowBehavior === "object" && value.windowBehavior !== null
      ? value.windowBehavior
      : undefined;
  const updateSettings =
    typeof value.updateSettings === "object" && value.updateSettings !== null
      ? value.updateSettings
      : undefined;
  const displayName = typeof userProfile?.displayName === "string"
    ? userProfile.displayName.trim()
    : GENERAL_SETTINGS_DEFAULTS.userProfile.displayName;

  return {
    themeMode: isThemeMode(value.themeMode) ? value.themeMode : GENERAL_SETTINGS_DEFAULTS.themeMode,
    userProfile: {
      displayName
    },
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

function resolveCacheTargetPaths(key: SidecarCacheCleanupKey): string[] {
  const configDir = getConfigDir();
  switch (key) {
    case "logs":
      return Array.from(new Set([
        join(configDir, "logs"),
        join(tmpdir(), "lume-logs")
      ]));
  }
}

function assertSafeCacheTarget(targetPath: string): void {
  const configDir = getConfigDir();
  const allowedRoots = [
    join(configDir, "cache"),
    join(configDir, "logs"),
    join(tmpdir(), "lume-logs")
  ].map((value) => resolve(value));
  const resolvedTarget = resolve(targetPath);
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

  assertSafeCacheTarget(targetPath);

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
        userProfile: { ...GENERAL_SETTINGS_DEFAULTS.userProfile },
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
  const displayName = typeof input.userProfile?.displayName === "string"
    ? input.userProfile.displayName.trim()
    : current.userProfile.displayName;
  const next: GeneralSettings = {
    themeMode: input.themeMode ?? current.themeMode,
    userProfile: {
      displayName
    },
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
