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
    // 主控制路径必须是内置 mcp__browser__* 工具（#260）：观察→动作→观察
    expect(skill).toContain("mcp__browser__snapshot");
    expect(skill).toContain("observe → act → observe");
    expect(skill).toContain("Never write browser JavaScript for ordinary interaction");
    expect(skill).toContain("next_cursor");
    expect(skill).toContain("A click that opens a new tab does not switch the lock");
    expect(skill).toContain("mcp__browser__handle_dialog");
    expect(skill).toContain("mcp__browser__fill_secret");
    expect(skill).toContain("user_takeover_required");
    // Node REPL 仅保留为诊断入口（#260：兼容与诊断，非默认控制路径）
    expect(skill).toContain("setupLumeBrowserRuntime");
    expect(skill).toContain("browser.tabs.resumeHandoff()");
    expect(skill).toContain("diagnostic entry point, not the default control path");
    expect(skill).toContain("Never claim Lume has no browser before attempting the built-in tools");
  });

});
