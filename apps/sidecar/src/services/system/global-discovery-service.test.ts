import { describe, expect, test } from "bun:test";
import { AGENT_IPC_CHANNELS, type SkillCatalogItem, type SkillTrustLevel } from "@lume/shared";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __internal } from "./global-discovery-service";

describe("global-discovery-service", () => {
  test("shared skills marketplace contracts 应暴露基础类型与 IPC 常量", () => {
    const trust: SkillTrustLevel = "trusted";
    const catalogItem: SkillCatalogItem = {
      id: "built-in:demo",
      slug: "demo",
      name: "Demo",
      sourceType: "built-in",
      trustLevel: trust,
      installState: "not-installed"
    };

    expect(catalogItem.name).toBe("Demo");
    expect(AGENT_IPC_CHANNELS.GET_SKILL_MARKET_CATALOG).toBe("agent:get-skill-market-catalog");
  });

  test("parseSkillFrontmatter 应解析 name/description/icon", () => {
    const content = `---
name: 示例技能
description: 用于测试
icon: sparkles
---

正文`;

    const meta = __internal.parseSkillFrontmatter(content, "demo-skill");
    expect(meta.name).toBe("示例技能");
    expect(meta.description).toBe("用于测试");
    expect(meta.icon).toBe("sparkles");
  });

  test("parseSkillFrontmatter 在无 frontmatter 时回退为 slug", () => {
    const meta = __internal.parseSkillFrontmatter("just content", "demo-skill");
    expect(meta.name).toBe("demo-skill");
    expect(meta.description).toBeUndefined();
    expect(meta.icon).toBeUndefined();
  });

  test("parseMarketplacePluginsFromInstallLocation 应解析 marketplace.json 插件清单", () => {
    const root = mkdtempSync(join(tmpdir(), "lume-marketplace-"));
    const pluginDir = join(root, ".claude-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "marketplace.json"),
      JSON.stringify({
        plugins: [
          {
            name: "demo-plugin",
            description: "for test",
            version: "1.0.0",
            source: "./plugins/demo-plugin"
          }
        ]
      }),
      "utf-8"
    );
    const warnings: Array<{ code: string; message: string }> = [];
    const plugins = __internal.parseMarketplacePluginsFromInstallLocation(root, warnings);
    expect(warnings.length).toBe(0);
    expect(plugins.length).toBe(1);
    expect(plugins[0]?.name).toBe("demo-plugin");
    expect(plugins[0]?.version).toBe("1.0.0");
  });
});
