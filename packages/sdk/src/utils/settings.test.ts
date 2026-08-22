import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
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
