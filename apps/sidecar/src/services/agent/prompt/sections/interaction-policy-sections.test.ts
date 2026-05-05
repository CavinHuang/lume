import { describe, expect, test } from "bun:test";
import { buildPlanModeSection } from "./interaction-policy-sections";

describe("interaction-policy-sections", () => {
  test("plan mode instructs agents to publish task contracts through TaskContractWrite", () => {
    const section = buildPlanModeSection();

    expect(section).toContain("TaskContractWrite");
    expect(section).toContain("needs_approval");
    expect(section).toContain("任务清单");
    expect(section).toContain("任务进度面板");
    expect(section).not.toContain("EnterPlanMode");
    expect(section).not.toContain("ExitPlanMode");
    expect(section).not.toContain(".context/plan/");
  });
});
