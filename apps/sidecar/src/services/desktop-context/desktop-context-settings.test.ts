import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
  loadDesktopAssistantSettings,
  saveDesktopAssistantSettings,
} from "./desktop-context-settings";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function settingsPath() {
  const dir = mkdtempSync(join(tmpdir(), "lume-desktop-settings-"));
  dirs.push(dir);
  return join(dir, "settings.json");
}

describe("desktop context settings", () => {
  test("defaults to disabled with an empty app allowlist", () => {
    expect(loadDesktopAssistantSettings(settingsPath())).toEqual(DEFAULT_DESKTOP_ASSISTANT_SETTINGS);
  });

  test("normalizes duplicate apps and unsafe numeric limits", () => {
    const path = settingsPath();
    writeFileSync(path, JSON.stringify({
      enabled: true,
      allowedApps: [" WeChat.exe ", "wechat.exe", ""],
      retentionHours: 0,
      maxStorageBytes: -1,
    }));
    expect(loadDesktopAssistantSettings(path)).toEqual({
      ...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
      enabled: true,
      allowedApps: ["wechat.exe"],
    });
  });

  test("writes settings atomically and roundtrips supported flags", () => {
    const path = settingsPath();
    const saved = saveDesktopAssistantSettings(path, {
      ...DEFAULT_DESKTOP_ASSISTANT_SETTINGS,
      enabled: true,
      allowedApps: ["wechat.exe"],
      proactiveEnabled: true,
    });
    expect(loadDesktopAssistantSettings(path)).toEqual(saved);
  });
});
