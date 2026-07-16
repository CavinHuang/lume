import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPersistedSettings,
  setPersistedSettingsMutationWriter,
  writePersistedSettings
} from "./settings-store";

describe("settings-store desktop acknowledgement", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-settings-ack-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    setPersistedSettingsMutationWriter(null);
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("keeps the pending snapshot visible and commits it after desktop acknowledgement", async () => {
    let acknowledge!: () => void;
    setPersistedSettingsMutationWriter(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    const pending = writePersistedSettings({ generalSettings: { themeMode: "dark" } });
    expect(readPersistedSettings()).toEqual({ generalSettings: { themeMode: "dark" } });
    acknowledge();
    await pending;
    expect(readPersistedSettings()).toEqual({ generalSettings: { themeMode: "dark" } });
  });

  test("rolls the cache back when desktop rejects persistence", async () => {
    setPersistedSettingsMutationWriter(async () => { throw new Error("disk full"); });
    await expect(writePersistedSettings({ generalSettings: { themeMode: "dark" } })).rejects.toThrow("disk full");
    expect(readPersistedSettings()).toEqual({});
  });
});
