import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { getSettingsPath } from "../infra/config-paths";
import { withIndexMutationLock } from "../infra/index-mutation-lock";

export interface SidecarSettingsStore {
  [key: string]: unknown;
}

type PersistedSettingsMutationWriter = (settings: SidecarSettingsStore) => Promise<void>;
let mutationWriter: PersistedSettingsMutationWriter | null = null;
let cachedSettings: { path: string; value: SidecarSettingsStore } | null = null;

function cloneSettings(settings: SidecarSettingsStore): SidecarSettingsStore {
  return JSON.parse(JSON.stringify(settings)) as SidecarSettingsStore;
}

export function setPersistedSettingsMutationWriter(writer: PersistedSettingsMutationWriter | null): void {
  mutationWriter = writer;
  if (writer) {
    const path = getSettingsPath();
    cachedSettings = { path, value: readPersistedSettingsFromDisk(path) };
  } else {
    cachedSettings = null;
  }
}

export class PersistedSettingsReadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PersistedSettingsReadError";
  }
}

export function readPersistedSettings(): SidecarSettingsStore {
  const path = getSettingsPath();
  if (cachedSettings?.path === path) return cloneSettings(cachedSettings.value);
  const value = readPersistedSettingsFromDisk(path);
  if (mutationWriter) cachedSettings = { path, value };
  return cloneSettings(value);
}

function readPersistedSettingsFromDisk(path: string): SidecarSettingsStore {
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

export async function writePersistedSettings(settings: SidecarSettingsStore): Promise<void> {
  const path = getSettingsPath();
  if (mutationWriter) {
    const snapshot = cloneSettings(settings);
    const previous = cachedSettings?.path === path ? cachedSettings : { path, value: readPersistedSettingsFromDisk(path) };
    cachedSettings = { path, value: snapshot };
    try {
      await mutationWriter(snapshot);
    } catch (error) {
      if (cachedSettings?.value === snapshot) cachedSettings = previous;
      throw error;
    }
    return;
  }
  writePersistedSettingsLocally(path, settings);
}

// 全程同步执行，锁的 takeover/release token 复核语义由共享实现统一继承（#526）
function writePersistedSettingsLocally(path: string, settings: SidecarSettingsStore): void {
  const lockPath = join(dirname(path), "settings.json.lock");
  withIndexMutationLock(lockPath, () => {
    const tempPath = join(dirname(path), "settings.json.tmp");
    const backupPath = join(dirname(path), "settings.json.bak");
    writeFileSync(tempPath, JSON.stringify(settings, null, 2), "utf-8");
    if (existsSync(backupPath)) {
      rmSync(backupPath, { force: true });
    }
    if (existsSync(path)) {
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
  });
}
