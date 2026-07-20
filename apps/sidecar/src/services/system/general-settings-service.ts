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
  type BuiltInThemePalette,
  type CustomThemePalette,
  type CustomThemePaletteColors,
  type GeneralSettings,
  type LumeLogLevel,
  type PersistedUiState,
  type ThemeMode,
  type ThemePalette,
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
import { createLogger } from "../infra/logger";

const log = createLogger("general-settings");

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
const CUSTOM_THEME_ID_PATTERN = /^custom:[a-z0-9][a-z0-9-]{0,47}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_CUSTOM_THEME_PALETTES = 12;

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function isBuiltInThemePalette(value: unknown): value is BuiltInThemePalette {
  return value === "mint"
    || value === "iris"
    || value === "clay"
    || value === "ocean"
    || value === "sakura"
    || value === "ember"
    || value === "mono"
    || value === "lavender"
    || value === "olive";
}

function sanitizeCustomThemeColors(input: unknown): CustomThemePaletteColors | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const value = input as Partial<CustomThemePaletteColors>;
  if (!HEX_COLOR_PATTERN.test(value.background ?? "")
    || !HEX_COLOR_PATTERN.test(value.surface ?? "")
    || !HEX_COLOR_PATTERN.test(value.text ?? "")
    || !HEX_COLOR_PATTERN.test(value.muted ?? "")
    || !HEX_COLOR_PATTERN.test(value.accent ?? "")) {
    return null;
  }
  return {
    background: value.background!,
    surface: value.surface!,
    text: value.text!,
    muted: value.muted!,
    accent: value.accent!
  };
}

function sanitizeCustomThemePalettes(input: unknown): CustomThemePalette[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const result: CustomThemePalette[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const value = item as Partial<CustomThemePalette>;
    const name = typeof value.name === "string" ? value.name.trim().slice(0, 32) : "";
    const light = sanitizeCustomThemeColors(value.light);
    const dark = sanitizeCustomThemeColors(value.dark);
    if (!CUSTOM_THEME_ID_PATTERN.test(value.id ?? "") || !name || !light || !dark || seen.has(value.id!)) {
      continue;
    }
    seen.add(value.id!);
    result.push({ id: value.id!, name, light, dark });
    if (result.length >= MAX_CUSTOM_THEME_PALETTES) break;
  }
  return result;
}

function isThemePalette(value: unknown, customThemePalettes: CustomThemePalette[]): value is ThemePalette {
  return isBuiltInThemePalette(value)
    || (typeof value === "string" && customThemePalettes.some((theme) => theme.id === value));
}

function isAgentMessageDisplayMode(value: unknown): value is AgentMessageDisplayMode {
  return value === "minimal" || value === "verbose";
}

function isLogLevel(value: unknown): value is LumeLogLevel {
  return value === "trace" || value === "debug" || value === "info"
    || value === "warn" || value === "error" || value === "fatal";
}

function sanitizeLoggingSettings(input: unknown): GeneralSettings["logging"] {
  const value = input && typeof input === "object"
    ? input as Partial<GeneralSettings["logging"]>
    : {};
  return {
    consoleLevel: isLogLevel(value.consoleLevel) ? value.consoleLevel : GENERAL_SETTINGS_DEFAULTS.logging.consoleLevel,
    fileLevel: isLogLevel(value.fileLevel) ? value.fileLevel : GENERAL_SETTINGS_DEFAULTS.logging.fileLevel,
    format: value.format === "json" || value.format === "pretty" ? value.format : GENERAL_SETTINGS_DEFAULTS.logging.format,
    retentionDays: Number.isFinite(value.retentionDays)
      ? Math.max(1, Math.min(365, Math.round(value.retentionDays!)))
      : GENERAL_SETTINGS_DEFAULTS.logging.retentionDays,
    maxSegmentMb: Number.isFinite(value.maxSegmentMb)
      ? Math.max(1, Math.min(1024, Math.round(value.maxSegmentMb!)))
      : GENERAL_SETTINGS_DEFAULTS.logging.maxSegmentMb,
    maxTotalMb: Number.isFinite(value.maxTotalMb)
      ? Math.max(10, Math.min(10_240, Math.round(value.maxTotalMb!)))
      : GENERAL_SETTINGS_DEFAULTS.logging.maxTotalMb,
    diagnosticCapture: sanitizeDiagnosticCapture(value.diagnosticCapture)
  };
}

function sanitizeDiagnosticCapture(input: unknown): GeneralSettings["logging"]["diagnosticCapture"] {
  const value = input && typeof input === "object"
    ? input as Partial<GeneralSettings["logging"]["diagnosticCapture"]>
    : {};
  const scope = value.scope && typeof value.scope === "object"
    ? {
        ...(typeof value.scope.threadId === "string" ? { threadId: value.scope.threadId.slice(0, 128) } : {}),
        ...(typeof value.scope.traceId === "string" ? { traceId: value.scope.traceId.slice(0, 128) } : {})
      }
    : null;
  const expiresAt = typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
    ? value.expiresAt
    : null;
  return {
    enabled: value.enabled === true && expiresAt !== null && Date.parse(expiresAt) > Date.now(),
    configVersion: Number.isSafeInteger(value.configVersion) && value.configVersion! > 0
      ? value.configVersion!
      : GENERAL_SETTINGS_DEFAULTS.logging.diagnosticCapture.configVersion,
    expiresAt,
    scope
  };
}

function sanitizeGeneralSettings(input: unknown): GeneralSettings {
  if (typeof input !== "object" || input === null) {
    return {
      ...GENERAL_SETTINGS_DEFAULTS,
      customThemePalettes: [],
      windowBehavior: { ...GENERAL_SETTINGS_DEFAULTS.windowBehavior },
      updateSettings: { ...GENERAL_SETTINGS_DEFAULTS.updateSettings },
      logging: { ...GENERAL_SETTINGS_DEFAULTS.logging }
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
  const customThemePalettes = sanitizeCustomThemePalettes(value.customThemePalettes);

  return {
    themeMode: isThemeMode(value.themeMode) ? value.themeMode : GENERAL_SETTINGS_DEFAULTS.themeMode,
    themePalette: isThemePalette(value.themePalette, customThemePalettes)
      ? value.themePalette
      : GENERAL_SETTINGS_DEFAULTS.themePalette,
    customThemePalettes,
    agentMessageDisplayMode: isAgentMessageDisplayMode(value.agentMessageDisplayMode)
      ? value.agentMessageDisplayMode
      : GENERAL_SETTINGS_DEFAULTS.agentMessageDisplayMode,
    logging: sanitizeLoggingSettings(value.logging),
    windowBehavior: {
      minimizeToTray:
        typeof windowBehavior?.minimizeToTray === "boolean"
          ? windowBehavior.minimizeToTray
          : GENERAL_SETTINGS_DEFAULTS.windowBehavior.minimizeToTray,
      closeToTray:
        typeof windowBehavior?.closeToTray === "boolean"
          ? windowBehavior.closeToTray
          : GENERAL_SETTINGS_DEFAULTS.windowBehavior.closeToTray,
      showTray:
        typeof windowBehavior?.showTray === "boolean"
          ? windowBehavior.showTray
          : GENERAL_SETTINGS_DEFAULTS.windowBehavior.showTray
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
      const paths = [getGlobalVectorIndexDir(), join(configDir, "wiki", ".lume", "index")];
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
    join(configDir, "wiki", ".lume", "index"),
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
      log.warn("failed to read settings; using general defaults", { error: error.cause ?? error });
      return {
        ...GENERAL_SETTINGS_DEFAULTS,
        customThemePalettes: [],
        windowBehavior: { ...GENERAL_SETTINGS_DEFAULTS.windowBehavior },
        updateSettings: { ...GENERAL_SETTINGS_DEFAULTS.updateSettings },
        logging: { ...GENERAL_SETTINGS_DEFAULTS.logging }
      };
    }
    throw error;
  }
}

export async function updatePersistedGeneralSettings(input: UpdateGeneralSettingsInput): Promise<GeneralSettings> {
  const settings = readPersistedSettings() as SidecarSettings;
  const current = sanitizeGeneralSettings(settings.generalSettings);
  const customThemePalettes = input.customThemePalettes === undefined
    ? current.customThemePalettes
    : sanitizeCustomThemePalettes(input.customThemePalettes);
  const requestedThemePalette = input.themePalette ?? current.themePalette;
  const next: GeneralSettings = {
    themeMode: input.themeMode ?? current.themeMode,
    themePalette: isThemePalette(requestedThemePalette, customThemePalettes)
      ? requestedThemePalette
      : GENERAL_SETTINGS_DEFAULTS.themePalette,
    customThemePalettes,
    agentMessageDisplayMode: input.agentMessageDisplayMode ?? current.agentMessageDisplayMode,
    logging: sanitizeLoggingSettings({ ...current.logging, ...(input.logging ?? {}) }),
    windowBehavior: (() => {
      const showTray = input.windowBehavior?.showTray ?? current.windowBehavior.showTray;
      return {
        minimizeToTray: showTray && (input.windowBehavior?.minimizeToTray ?? current.windowBehavior.minimizeToTray),
        closeToTray: showTray && (input.windowBehavior?.closeToTray ?? current.windowBehavior.closeToTray),
        showTray
      };
    })(),
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
  await writePersistedSettings(settings);
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
