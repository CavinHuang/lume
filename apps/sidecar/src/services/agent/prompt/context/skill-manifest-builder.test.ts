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

  test("renders display names alongside skill ids", () => {
    const lines = renderSkillManifestLines({
      workspaceSlug: "demo",
      skills: [
        {
          slug: "skill-creator",
          name: "Skill 生成器",
          description: "创建和优化技能"
        }
      ]
    });

    expect(lines).toContain("- skill-creator (Skill 生成器): 创建和优化技能");
  });

  test("renders argument hints but keeps trigger details out of model-visible manifest", () => {
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
    expect(rendered).toContain("- planner: Breaks work into clear execution plans. Args: pass the target feature");
    expect(rendered).not.toContain("when the user asks for a plan");
    expect(rendered).not.toContain("Trigger:");
    expect(rendered).not.toContain("manual-only");
  });
});
