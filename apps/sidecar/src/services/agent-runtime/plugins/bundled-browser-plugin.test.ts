import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..", "bundled-plugins", "browser");

describe("bundled browser plugin", () => {
  test("ships the manifest and the control-browser skill", () => {
    // 打包契约:desktop extraResources 把整个 bundled-plugins 目录拷进
    // resources/bundled-plugins,sidecar 经 LUME_BUNDLED_PLUGINS_DIR 扫描
    // (.lume-plugin/plugin.json 发现插件,skills 目录发现技能)。
    // 插件本体缺失时该链路静默无声,在此锁定文件与关键字段。
    const required = [
      ".lume-plugin/plugin.json",
      "skills/control-browser/SKILL.md",
    ];
    expect(required.every((path) => existsSync(resolve(ROOT, path)))).toBe(true);

    const manifest = JSON.parse(readFileSync(resolve(ROOT, ".lume-plugin/plugin.json"), "utf8"));
    expect(manifest).toMatchObject({
      schema: "lume-plugin/v1",
      name: "browser",
      skills: ["./skills"],
    });

    const skill = readFileSync(resolve(ROOT, "skills/control-browser/SKILL.md"), "utf8");
    expect(skill).toContain("name: control-browser");
    expect(skill).toContain("mcp__browser__tabs_list");
  });
});
