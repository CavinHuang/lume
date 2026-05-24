import { describe, expect, test } from "bun:test";
import { CAPABILITY_ROUTING_SECTION, CLAUDE_PLAN_MODE_SECTION } from "./static-policy-sections";

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

  test("main agent should directly create subagents for complex specialized work", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("directly use the Agent tool");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("create the appropriate SubAgent");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("multi-step, context-heavy, or cross-domain");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("explorer -> planner -> specialist -> code-reviewer");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("Ask first only when");
  });

  test("capability routing prefers subagents when specialization materially helps", () => {
    expect(CAPABILITY_ROUTING_SECTION).toContain("Prefer SubAgents when specialization");
    expect(CAPABILITY_ROUTING_SECTION).toContain("context isolation");
    expect(CAPABILITY_ROUTING_SECTION).toContain("parallelism");
    expect(CAPABILITY_ROUTING_SECTION).toContain("review");
  });
});
