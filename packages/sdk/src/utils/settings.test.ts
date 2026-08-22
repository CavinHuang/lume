import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getSettingsFileForSource, loadSettingsFromSources } from "./settings.js";

describe("getSettingsFileForSource", () => {
  test("'user' resolves to ~/.lume, not the project file (#230)", () => {
    const userPath = getSettingsFileForSource(join("D:", "proj"), "user");
    expect(userPath).toBe(join(homedir(), ".lume", "settings.json"));
    expect(userPath).not.toBe(getSettingsFileForSource(join("D:", "proj"), "project"));
  });

  test("'project' and 'local' stay relative to cwd", () => {
    const cwd = join("D:", "proj");
    expect(getSettingsFileForSource(cwd, "project")).toBe(join(cwd, "settings.json"));
    expect(getSettingsFileForSource(cwd, "local")).toBe(join(cwd, "settings.local.json"));
  });
});

describe("getSettingsFileForSource LUME_CONFIG_DIR (#291)", () => {
  const previousConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
  });

  test("'user' follows LUME_CONFIG_DIR when set", () => {
    process.env.LUME_CONFIG_DIR = join("D:", "custom-lume");
    expect(getSettingsFileForSource(join("D:", "proj"), "user")).toBe(
      join("D:", "custom-lume", "settings.json"),
    );
  });

  test("relative LUME_CONFIG_DIR resolves against cwd like fs-loader", () => {
    process.env.LUME_CONFIG_DIR = join("relative", "lume");
    expect(getSettingsFileForSource(join("D:", "proj"), "user")).toBe(
      resolve(process.cwd(), "relative", "lume", "settings.json"),
    );
  });

  test("blank or unset falls back to ~/.lume", () => {
    delete process.env.LUME_CONFIG_DIR;
    const fallback = getSettingsFileForSource(join("D:", "proj"), "user");
    expect(fallback).toBe(join(homedir(), ".lume", "settings.json"));

    process.env.LUME_CONFIG_DIR = "   ";
    expect(getSettingsFileForSource(join("D:", "proj"), "user")).toBe(fallback);
  });
});

describe("loadSettingsFromSources error handling (#354)", () => {
  test("warns for unreadable settings files with their paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-settings-"));
    const badPath = join(dir, "settings.json");
    await writeFile(badPath, "{ not valid json");

    // Snapshot warnings before mockRestore(): it clears mock.calls.
    const warned: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    });
    let loaded;
    try {
      loaded = await loadSettingsFromSources(dir, ["project"]);
    } finally {
      warn.mockRestore();
    }
    expect(loaded).toHaveLength(0);
    expect(warned.some((message) => message.includes(badPath))).toBe(true);
  });

  test("missing files stay silent and are skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-settings-"));

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let loaded;
    try {
      loaded = await loadSettingsFromSources(dir, ["local"]);
    } finally {
      warn.mockRestore();
    }
    expect(loaded).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("valid settings still load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lume-settings-"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ model: "test-model" }));

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let loaded;
    try {
      loaded = await loadSettingsFromSources(dir, ["project"]);
    } finally {
      warn.mockRestore();
    }
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.settings.model).toBe("test-model");
  });
});
