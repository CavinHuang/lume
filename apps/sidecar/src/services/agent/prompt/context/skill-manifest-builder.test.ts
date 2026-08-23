import { describe, expect, test } from "bun:test";
import { compactSkillDescription, renderSkillManifestLines } from "./skill-manifest-builder";

describe("skill-manifest-builder", () => {
  test("uses weak trigger copy for brainstorming", () => {
    expect(compactSkillDescription("brainstorming", "Use this before any creative work.")).toBe(
      "需求不清时的模糊产品/设计探索"
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

    expect(lines).toContain("已加载 Skill：");
    expect(lines).toContain("- Skill 调用前缀: lume-workspace-demo:");
    expect(lines).toContain("- 以 <前缀><skill-slug> 调用；下表仅列 slug 以节省 prompt token");
    // Skill 匹配时机的指令由静态 prompt「## 执行模式」段单点声明
    expect(lines.join("\n")).not.toContain("clearly matches");
    expect(lines.join("\n")).not.toContain("raw tool composition");
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
