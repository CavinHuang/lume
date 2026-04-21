import { describe, expect, test } from "bun:test";
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
  test("catalog merges built-in, workspace, and global skills into one list", () => {
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
          id: "claude:skill:beta",
          slug: "beta",
          name: "Beta",
          sourceType: "local",
          trustLevel: "trusted"
        })
      ],
      workspaceSkills: [
        { slug: "alpha", name: "Alpha" },
        { slug: "gamma", name: "Gamma", version: "1.0.0" }
      ]
    });

    expect(result.items.map((item) => item.slug)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.items.find((item) => item.slug === "alpha")?.installState).toBe("installed");
    expect(result.items.find((item) => item.slug === "gamma")?.sourceType).toBe("local");
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

  test("imported global/local skills become installed when present in workspace", () => {
    const result = __internal.buildSkillMarketCatalog({
      sources: [
        makeSource({
          id: "claude:skill:beta",
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
});
