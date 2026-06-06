import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SkillCatalogItem } from "@lume/shared";
import { __internal } from "./skills-market-service";

function makeSource(
  input: Partial<SkillCatalogItem> & Pick<SkillCatalogItem, "id" | "slug" | "name" | "sourceType" | "trustLevel">
): SkillCatalogItem {
  return {
    installState: "not-installed",
    ...input
  };
}

describe("skills-market-service", () => {
  test("catalog merges market sources and installed market skills into one list", () => {
    const result = __internal.buildSkillMarketCatalog({
      sources: [
        makeSource({
          id: "built-in:alpha",
          slug: "alpha",
          name: "Alpha",
          sourceType: "built-in",
          trustLevel: "trusted"
        }),
        makeSource({
          id: "local:skill:beta",
          slug: "beta",
          name: "Beta",
          sourceType: "local",
          trustLevel: "trusted"
        })
      ],
      workspaceSkills: [
        { slug: "alpha", name: "Alpha" },
        { slug: "gamma", name: "Gamma", version: "1.0.0" }
      ],
      installedSourceMetadata: {
        gamma: {
          sourceType: "github",
          trustLevel: "review-required"
        }
      }
    });

    expect(result.items.map((item) => item.slug)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.items.find((item) => item.slug === "alpha")?.installState).toBe("installed");
    expect(result.items.find((item) => item.slug === "gamma")?.sourceType).toBe("github");
  });

  test("built-in skills are marked trusted by default", () => {
    const result = __internal.buildSkillMarketCatalog({
      sources: [
        makeSource({
          id: "built-in:alpha",
          slug: "alpha",
          name: "Alpha",
          sourceType: "built-in",
          trustLevel: "trusted"
        })
      ],
      workspaceSkills: []
    });

    expect(result.items[0]?.trustLevel).toBe("trusted");
  });

  test("imported local skills become installed when present in workspace", () => {
    const result = __internal.buildSkillMarketCatalog({
      sources: [
        makeSource({
          id: "local:skill:beta",
          slug: "beta",
          name: "Beta",
          sourceType: "local",
          trustLevel: "trusted"
        })
      ],
      workspaceSkills: [{ slug: "beta", name: "Beta" }]
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.installState).toBe("installed");
  });

  test("catalog excludes workspace-owned skills that do not come from a market source", () => {
    const result = __internal.buildSkillMarketCatalog({
      sources: [],
      workspaceSkills: [
        { slug: "private-helper", name: "Private Helper", version: "1.0.0" }
      ]
    });

    expect(result.items.map((item) => item.slug)).not.toContain("private-helper");
    expect(result.items).toHaveLength(0);
  });

  test("installed skills show update-available when the market source has a newer version", () => {
    const result = __internal.buildSkillMarketCatalog({
      sources: [
        makeSource({
          id: "built-in:alpha",
          slug: "alpha",
          name: "Alpha",
          version: "1.2.0",
          sourceType: "built-in",
          trustLevel: "trusted"
        })
      ],
      workspaceSkills: [{ slug: "alpha", name: "Alpha", version: "1.0.0" }]
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.installState).toBe("update-available");
    expect(result.items[0]?.version).toBe("1.2.0");
  });

  test("catalog hides blocked subscribed-market items unless explicitly enabled", () => {
    const blockedSource = makeSource({
      id: "market:delta",
      slug: "delta",
      name: "Delta",
      sourceType: "subscribed-market",
      trustLevel: "blocked-by-default"
    });

    const hidden = __internal.buildSkillMarketCatalog({
      sources: [blockedSource],
      workspaceSkills: []
    });
    const visible = __internal.buildSkillMarketCatalog({
      sources: [blockedSource],
      workspaceSkills: [],
      includeBlockedSources: true
    });

    expect(hidden.items).toHaveLength(0);
    expect(visible.items.map((item) => item.slug)).toEqual(["delta"]);
  });

  test("workspace-installed github skills keep github source and review-required trust", () => {
    const result = __internal.buildSkillMarketCatalog({
      sources: [],
      workspaceSkills: [{ slug: "prompt-library", name: "Prompt Library" }],
      installedSourceMetadata: {
        "prompt-library": {
          sourceType: "github",
          trustLevel: "review-required"
        }
      }
    });

    expect(result.items[0]?.sourceType).toBe("github");
    expect(result.items[0]?.trustLevel).toBe("review-required");
    expect(result.items[0]?.installState).toBe("installed");
  });

  test("local source discovery accepts either a skill directory or a directory of skills", () => {
    const root = join(tmpdir(), `lume-local-skills-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const singleSkill = join(root, "single-skill");
      const marketRoot = join(root, "market");
      mkdirSync(singleSkill, { recursive: true });
      mkdirSync(join(marketRoot, "alpha"), { recursive: true });
      mkdirSync(join(marketRoot, "beta"), { recursive: true });
      writeFileSync(join(singleSkill, "SKILL.md"), "---\nname: Single\n---\n", "utf-8");
      writeFileSync(join(marketRoot, "alpha", "SKILL.md"), "---\nname: Alpha\n---\n", "utf-8");
      writeFileSync(join(marketRoot, "beta", "SKILL.md"), "---\nname: Beta\n---\n", "utf-8");

      expect(__internal.discoverSkillDirsFromLocalPath(singleSkill).map((item) => item.slug)).toEqual(["single-skill"]);
      expect(__internal.discoverSkillDirsFromLocalPath(marketRoot).map((item) => item.slug)).toEqual(["alpha", "beta"]);
    } finally {
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("persisted local skill sources remain visible after workspace removal", () => {
    const root = join(tmpdir(), `lume-local-source-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "SKILL.md"), "---\nname: Reloadable\ndescription: Can be reinstalled\n---\n", "utf-8");

      const sources = __internal.normalizeMetadataSkillSources({
        reloadable: {
          sourceType: "local",
          sourcePath: root,
          trustLevel: "trusted",
          installedAt: Date.now()
        }
      });
      const catalog = __internal.buildSkillMarketCatalog({
        sources,
        workspaceSkills: []
      });

      expect(catalog.items).toHaveLength(1);
      expect(catalog.items[0]?.slug).toBe("reloadable");
      expect(catalog.items[0]?.name).toBe("Reloadable");
      expect(catalog.items[0]?.sourceId).toBe("local:skill:reloadable");
      expect(catalog.items[0]?.installState).toBe("not-installed");
    } finally {
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("file tree keeps directories first and returns relative paths", () => {
    const root = join(tmpdir(), `lume-skill-tree-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      mkdirSync(join(root, "references"), { recursive: true });
      writeFileSync(join(root, "SKILL.md"), "---\nname: Tree\n---\n", "utf-8");
      writeFileSync(join(root, "references", "guide.md"), "# Guide\n", "utf-8");
      writeFileSync(join(root, "README.md"), "# Readme\n", "utf-8");

      const tree = __internal.buildFileTreeFromDir(root);

      expect(tree.map((item) => item.path)).toEqual(["references", "README.md", "SKILL.md"]);
      expect(tree[0]?.children?.map((item) => item.path)).toEqual(["references/guide.md"]);
      expect(tree.find((item) => item.path === "SKILL.md")?.content).toContain("name: Tree");
      expect(tree[0]?.children?.[0]?.content).toBe("# Guide\n");
    } finally {
      if (existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
