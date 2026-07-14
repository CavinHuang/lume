import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..", "bundled-plugins", "computer-use");

describe("bundled computer-use plugin", () => {
  test("ships the manifest, skill, guidance, API, confirmations, and trusted client", () => {
    const required = [
      ".lume-plugin/plugin.json",
      "skills/computer-use/SKILL.md",
      "docs/guidance.md",
      "docs/api.md",
      "docs/confirmations.md",
      "scripts/computer-use-client.mjs",
    ];
    expect(required.every((path) => existsSync(resolve(ROOT, path)))).toBe(true);

    const manifest = JSON.parse(readFileSync(resolve(ROOT, ".lume-plugin/plugin.json"), "utf8"));
    expect(manifest).toMatchObject({
      schema: "lume-plugin/v1",
      name: "computer-use",
      skills: ["./skills"],
    });
    const skill = readFileSync(resolve(ROOT, "skills/computer-use/SKILL.md"), "utf8");
    expect(skill).toContain("setupComputerUseRuntime");
    expect(skill).toContain('sky.documentation("guidance")');
    expect(skill).toContain('sky.documentation("confirmations")');
  });
});
