import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..", "bundled-plugins", "browser");

describe("bundled browser plugin", () => {
  test("ships the manifest, skill, documentation, and trusted client", () => {
    const required = [
      ".lume-plugin/plugin.json",
      "skills/browser/SKILL.md",
      "scripts/browser-client.mjs",
      "scripts/browser-client.test.mjs",
      "dist/browser-client.js",
      "docs/browser-safety.md",
      "docs/api-use-behavior.md",
      "docs/confirmations.md",
      "docs/browser-troubleshooting.md",
    ];
    expect(required.every((path) => existsSync(resolve(ROOT, path)))).toBe(true);

    const manifest = JSON.parse(readFileSync(resolve(ROOT, ".lume-plugin/plugin.json"), "utf8"));
    expect(manifest).toMatchObject({
      schema: "lume-plugin/v1",
      name: "browser",
      skills: ["./skills"],
    });
    const skill = readFileSync(resolve(ROOT, "skills/browser/SKILL.md"), "utf8");
    expect(skill).toContain("setupLumeBrowserRuntime");
    expect(skill).toContain("agent.browsers.getDefault()");
    expect(skill).toContain("browser.tabs.new()");
    expect(skill).toContain("Set `timeout_ms` to `300000`");
    expect(skill).toContain("nodeRepl.write(JSON.stringify");
    expect(skill).toContain("Never claim Lume has no browser before attempting this runtime");
  });

});
