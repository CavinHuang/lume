import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSettingsPath } from "../infra/config-paths";

export interface SidecarSettingsStore {
  [key: string]: unknown;
}

export class PersistedSettingsReadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PersistedSettingsReadError";
  }
}

export function readPersistedSettings(): SidecarSettingsStore {
  const path = getSettingsPath();
  if (!existsSync(path)) {
    return {};
  }

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as SidecarSettingsStore;
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch (error) {
    throw new PersistedSettingsReadError(
      `Failed to parse persisted settings at ${path}`,
      error
    );
  }
}

export function writePersistedSettings(settings: SidecarSettingsStore): void {
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
