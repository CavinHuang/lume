import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  GENERAL_SETTINGS_DEFAULTS,
  type ClearCacheInput,
  type ClearCacheResult,
  type GeneralSettings,
  type GeneralSettingsCacheKey,
  type PersistedUiState,
  type ThemeMode,
  type UpdateGeneralSettingsInput
} from "@lume/shared";
import { getConfigDir, getSettingsPath } from "../infra/config-paths";

interface SidecarSettings {
  uiState?: PersistedUiState;
  generalSettings?: GeneralSettings;
  [key: string]: unknown;
}

const CACHE_KEYS: GeneralSettingsCacheKey[] = ["frontendTemp", "previewRender", "logs"];

function readSettings(): SidecarSettings {
  const path = getSettingsPath();
  if (!existsSync(path)) {
    return {};
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as SidecarSettings;
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch (error) {
    console.warn("[General Settings] 读取 settings.json 失败，回退默认值:", error);
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

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function sanitizeGeneralSettings(input: unknown): GeneralSettings {
  if (typeof input !== "object" || input === null) {
    return {
      ...GENERAL_SETTINGS_DEFAULTS,
      windowBehavior: { ...GENERAL_SETTINGS_DEFAULTS.windowBehavior }
    };
  }

  const value = input as Partial<GeneralSettings>;
  const windowBehavior =
    typeof value.windowBehavior === "object" && value.windowBehavior !== null
      ? value.windowBehavior
      : undefined;

  return {
    themeMode: isThemeMode(value.themeMode) ? value.themeMode : GENERAL_SETTINGS_DEFAULTS.themeMode,
    windowBehavior: {
      minimizeToTray:
        typeof windowBehavior?.minimizeToTray === "boolean"
          ? windowBehavior.minimizeToTray
          : GENERAL_SETTINGS_DEFAULTS.windowBehavior.minimizeToTray,
      closeToTray:
        typeof windowBehavior?.closeToTray === "boolean"
          ? windowBehavior.closeToTray
          : GENERAL_SETTINGS_DEFAULTS.windowBehavior.closeToTray
    }
  };
}

function resolveCacheTargetPaths(key: GeneralSettingsCacheKey): string[] {
  const configDir = getConfigDir();
  switch (key) {
    case "frontendTemp":
      return [join(configDir, "cache", "frontend-temp")];
    case "previewRender":
      return [join(configDir, "cache", "preview-render")];
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
  const settings = readSettings();
  return sanitizeGeneralSettings(settings.generalSettings);
}

export function updatePersistedGeneralSettings(input: UpdateGeneralSettingsInput): GeneralSettings {
  const settings = readSettings();
  const current = sanitizeGeneralSettings(settings.generalSettings);
  const next: GeneralSettings = {
    themeMode: input.themeMode ?? current.themeMode,
    windowBehavior: {
      minimizeToTray: input.windowBehavior?.minimizeToTray ?? current.windowBehavior.minimizeToTray,
      closeToTray: input.windowBehavior?.closeToTray ?? current.windowBehavior.closeToTray
    }
  };
  settings.generalSettings = next;
  writeSettings(settings);
  return next;
}

export function clearGeneralSettingsCaches(input: ClearCacheInput): ClearCacheResult {
  const result: ClearCacheResult = {
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
