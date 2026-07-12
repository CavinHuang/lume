import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DesktopAssistantSettings } from "@lume/shared";

export const DEFAULT_DESKTOP_ASSISTANT_SETTINGS: DesktopAssistantSettings = {
  enabled: false,
  allowedApps: [],
  retentionHours: 24,
  maxStorageBytes: 2 * 1024 * 1024 * 1024,
  proactiveEnabled: false,
  notificationsEnabled: true,
  dailyWrapEnabled: false,
};

export function loadDesktopAssistantSettings(path: string): DesktopAssistantSettings {
  if (!existsSync(path)) return structuredClone(DEFAULT_DESKTOP_ASSISTANT_SETTINGS);
  try {
    return normalizeDesktopAssistantSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return structuredClone(DEFAULT_DESKTOP_ASSISTANT_SETTINGS);
  }
}

export function saveDesktopAssistantSettings(path: string, value: DesktopAssistantSettings): DesktopAssistantSettings {
  const normalized = normalizeDesktopAssistantSettings(value);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(normalized, null, 2), "utf8");
  renameSync(temporary, path);
  return normalized;
}

export function normalizeDesktopAssistantSettings(value: unknown): DesktopAssistantSettings {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const allowedApps = Array.isArray(input.allowedApps)
    ? [...new Set(input.allowedApps
      .filter((app): app is string => typeof app === "string")
      .map((app) => app.trim().toLowerCase())
      .filter(Boolean))]
    : [];
  return {
    enabled: input.enabled === true,
    allowedApps,
    retentionHours: positiveNumber(input.retentionHours, DEFAULT_DESKTOP_ASSISTANT_SETTINGS.retentionHours),
    maxStorageBytes: positiveNumber(input.maxStorageBytes, DEFAULT_DESKTOP_ASSISTANT_SETTINGS.maxStorageBytes),
    proactiveEnabled: input.proactiveEnabled === true,
    notificationsEnabled: input.notificationsEnabled !== false,
    dailyWrapEnabled: input.dailyWrapEnabled === true,
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
