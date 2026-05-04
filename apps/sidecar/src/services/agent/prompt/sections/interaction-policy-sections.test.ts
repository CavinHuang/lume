import { describe, expect, test } from "bun:test";
import { buildPlanModeSection } from "./interaction-policy-sections";

describe("interaction-policy-sections", () => {
  test("plan mode instructs agents to publish structured plans through PlanWrite", () => {
    const section = buildPlanModeSection();

    expect(section).toContain("PlanWrite");
    expect(section).toContain("needs_approval");
    expect(section).not.toContain("EnterPlanMode");
    expect(section).not.toContain("ExitPlanMode");
    expect(section).not.toContain(".context/plan/");
  });
});
