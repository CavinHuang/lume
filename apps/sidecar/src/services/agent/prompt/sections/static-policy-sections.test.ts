import { describe, expect, test } from "bun:test";
import { CLAUDE_PLAN_MODE_SECTION } from "./static-policy-sections";

describe("static policy sections", () => {
  test("agent role handoff instructions mention explicit subagent_type routing", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("subagent_type");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("developer");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("designer");
  });

  test("long-form prose is delegated to the writing agent", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("hand off to the writing agent before drafting");
  });

  test("main agent should directly create subagents for complex specialized work", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("Use SubAgents proactively");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("multi-step, context-heavy, or cross-domain");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("explorer -> planner -> specialist -> code-reviewer");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("Ask first only when");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("Built-ins include explorer, planner, code-reviewer, researcher");
  });

  test("capability ladder keeps memory and web lookups conditional", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("use memory tools only when prior context is needed");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("use WebSearch/WebFetch for current public information");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("parallelizable or review tasks");
  });

  test("coding loop keeps verification hard rules", () => {
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("never piped through grep, findstr, Select-String, head, or tail");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("do not poll for its output");
    expect(CLAUDE_PLAN_MODE_SECTION).toContain("Never commit, push, reset, clean, or delete a branch automatically");
  });
});
