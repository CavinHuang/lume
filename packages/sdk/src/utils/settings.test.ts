import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getSettingsFileForSource } from "./settings.js";

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
