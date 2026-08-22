import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  GENERAL_SETTINGS_DEFAULTS,
  type AgentMessageAvatarMode,
  type AgentMessageDisplayMode,
  type AgentMessageListDisplayMode,
  type BuiltInThemePalette,
  type ChatFontScale,
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
  getAgentWorkspacesDir,
  getSettingsPath
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

function isAgentMessageListDisplayMode(value: unknown): value is AgentMessageListDisplayMode {
  return value === "conversation" || value === "left_aligned";
}

function isAgentMessageAvatarMode(value: unknown): value is AgentMessageAvatarMode {
  return value === "visible" || value === "hidden";
}

function isChatFontScale(value: unknown): value is ChatFontScale {
  return value === "sm" || value === "md" || value === "lg";
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
    agentMessageListDisplayMode: isAgentMessageListDisplayMode(value.agentMessageListDisplayMode)
      ? value.agentMessageListDisplayMode
      : GENERAL_SETTINGS_DEFAULTS.agentMessageListDisplayMode,
    agentMessageAvatarMode: isAgentMessageAvatarMode(value.agentMessageAvatarMode)
      ? value.agentMessageAvatarMode
      : GENERAL_SETTINGS_DEFAULTS.agentMessageAvatarMode,
    chatFontScale: isChatFontScale(value.chatFontScale)
      ? value.chatFontScale
      : GENERAL_SETTINGS_DEFAULTS.chatFontScale,
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
    },
    agentIsland: {
      enabled:
        typeof value.agentIsland?.enabled === "boolean"
          ? value.agentIsland.enabled
          : GENERAL_SETTINGS_DEFAULTS.agentIsland.enabled
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

/**
 * Task 6 fix round 2：bypass sidecar cache，直接从磁盘 settings.json 读
 * `generalSettings.islandWindowPosition`。
 *
 * 背景：main 的 `persistIslandWindowPosition` 走 main broker.mutate 写 settings.json，
 * 不通知 sidecar。sidecar 的 `readPersistedSettings` 在 cache hit 时永不重读 disk
 * （settings-store.ts:42-48），因此在 sidecar 进程持续运行期间，main 写入的
 * islandWindowPosition 不会反映到 sidecar cache。若 `updatePersistedGeneralSettings`
 * 仍读 cache（round 1 的 best-effort 透传），live scenario 下 `next` 不含该字段 →
 * wholesale replace 覆盖丢失。
 *
 * 用户改设置是低频操作；这里同步读 disk 可接受。仅在 islandWindowPosition 这一个
 * 字段上 bypass cache，其他字段仍走 `readPersistedSettings` 既有 cache 语义。
 */
function readIslandWindowPositionFromDisk(): { x: number; y: number } | null | undefined {
  try {
    if (!existsSync(getSettingsPath())) return undefined;
    const raw = JSON.parse(readFileSync(getSettingsPath(), "utf-8")) as
      | { generalSettings?: { islandWindowPosition?: { x?: unknown; y?: unknown } | null } }
      | null;
    const pos = raw?.generalSettings?.islandWindowPosition;
    if (pos == null) return pos ?? undefined;
    if (
      typeof pos.x === "number" && Number.isFinite(pos.x) &&
      typeof pos.y === "number" && Number.isFinite(pos.y)
    ) {
      return { x: pos.x, y: pos.y };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function updatePersistedGeneralSettings(input: UpdateGeneralSettingsInput): Promise<GeneralSettings> {
  const settings = readPersistedSettings() as SidecarSettings;
  const current = sanitizeGeneralSettings(settings.generalSettings);
  const customThemePalettes = input.customThemePalettes === undefined
    ? current.customThemePalettes
    : sanitizeCustomThemePalettes(input.customThemePalettes);
  const requestedThemePalette = input.themePalette ?? current.themePalette;
  // Task 6 fix round 2：bypass cache 读 disk 的 islandWindowPosition，避免 main 写
  // 后 sidecar cache stale 导致 wholesale replace 覆盖丢失。
  const diskIslandWindowPosition = readIslandWindowPositionFromDisk();
  const next: GeneralSettings = {
    themeMode: input.themeMode ?? current.themeMode,
    themePalette: isThemePalette(requestedThemePalette, customThemePalettes)
      ? requestedThemePalette
      : GENERAL_SETTINGS_DEFAULTS.themePalette,
    customThemePalettes,
    agentMessageDisplayMode: input.agentMessageDisplayMode ?? current.agentMessageDisplayMode,
    agentMessageListDisplayMode: input.agentMessageListDisplayMode ?? current.agentMessageListDisplayMode,
    agentMessageAvatarMode: input.agentMessageAvatarMode ?? current.agentMessageAvatarMode,
    chatFontScale: input.chatFontScale ?? current.chatFontScale,
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
    },
    agentIsland: {
      enabled: input.agentIsland?.enabled ?? current.agentIsland.enabled
    },
    // Task 6 fix round 1+2：保留 main 写入的 islandWindowPosition。
    // 仅在 disk 有有效值时带上，保持缺省时的既有 persisted 形状（不强制写 null，
    // 避免破坏现有 toEqual 契约）。
    ...(diskIslandWindowPosition
      ? { islandWindowPosition: diskIslandWindowPosition }
      : {})
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
