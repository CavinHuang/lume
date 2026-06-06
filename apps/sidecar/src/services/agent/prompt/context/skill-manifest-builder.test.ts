import { describe, expect, test } from "bun:test";
import { compactSkillDescription, renderSkillManifestLines } from "./skill-manifest-builder";

describe("skill-manifest-builder", () => {
  test("uses weak trigger copy for brainstorming", () => {
    expect(compactSkillDescription("brainstorming", "Use this before any creative work.")).toBe(
      "ambiguous product/design exploration when requirements are unclear"
    );
  });

  test("renders compact skill manifest with prefix declared once", () => {
    const lines = renderSkillManifestLines({
      workspaceSlug: "demo",
      skills: [
        {
          slug: "planner",
          description: "Breaks work into clear execution plans. Additional details should not be included."
        }
      ]
    });

    expect(lines).toContain("Loaded Skills:");
    expect(lines).toContain("- Skill call prefix: lume-workspace-demo:");
    expect(lines).toContain("- Call skills as <prefix><skill-slug>; list below shows slugs only to save prompt tokens");
    expect(lines).toContain("- planner: Breaks work into clear execution plans.");
    expect(lines.join("\n")).not.toContain("Additional details");
    expect(lines.join("\n").match(/lume-workspace-demo:/g)).toHaveLength(1);
  });

  test("renders trigger and argument hints but skips model-disabled skills", () => {
    const lines = renderSkillManifestLines({
      workspaceSlug: "demo",
      skills: [
        {
          slug: "planner",
          description: "Breaks work into clear execution plans.",
          whenToUse: "when the user asks for a plan",
          argumentHint: "pass the target feature"
        },
        {
          slug: "manual-only",
          description: "Only for explicit slash usage.",
          disableModelInvocation: true
        }
      ]
    });

    const rendered = lines.join("\n");
    expect(rendered).toContain("- planner: Breaks work into clear execution plans. Trigger: when the user asks for a plan Args: pass the target feature");
    expect(rendered).not.toContain("manual-only");
  });
});
