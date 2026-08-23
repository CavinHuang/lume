import { describe, expect, test } from "bun:test";
import { buildBuiltinAgents } from "./agent-prompt-builder";

describe("agent role runtime mapping", () => {
  test("registers Alice-style agent roles as runtime built-ins", () => {
    const agents = buildBuiltinAgents();

    expect(Object.keys(agents)).toContain("developer");
    expect(Object.keys(agents)).toContain("designer");
    expect(agents.developer?.description).toContain("全栈开发");
    expect(agents.designer?.prompt).toContain("林澄");
    expect(agents.developer?.model).toBe("inherit");
  });

  test("maps read-only roles to read/search tools without edit tools", () => {
    const researcher = buildBuiltinAgents().researcher;

    expect(researcher?.prompt).toContain("顾砚");
    expect(researcher?.tools).toEqual(["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"]);
    expect(researcher?.tools).not.toContain("Write");
    expect(researcher?.tools).not.toContain("Edit");
  });

  test("keeps writable roles governed by default subagent tools", () => {
    const developer = buildBuiltinAgents().developer;

    expect(developer?.prompt).toContain("祁远");
    expect(developer?.tools).toBeUndefined();
    expect(developer?.disallowedTools).toEqual(["Agent"]);
  });
});
