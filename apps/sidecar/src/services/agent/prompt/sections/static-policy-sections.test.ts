import { describe, expect, test } from "bun:test";
import { CLAUDE_PLAN_MODE_SECTION } from "./static-policy-sections";

describe("static policy sections", () => {
  test("agent role handoff instructions mention explicit subagent_type routing", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("subagent_type");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("developer");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("designer");
  });

  test("main agent should proactively recommend fitting built-in agents", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("proactively recommend");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("built-in SubAgent");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("before drafting");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain('subagent_type "writer"');
  });
});
