import { describe, expect, test } from "bun:test";
import { buildPlanModeSection } from "./interaction-policy-sections";

describe("interaction-policy-sections", () => {
  test("plan mode instructs agents to publish reviewable plans through TaskContractWrite", () => {
    const section = buildPlanModeSection();

    expect(section).toContain("TaskContractWrite");
    expect(section).toContain("planMarkdown");
    expect(section).toContain("Markdown");
    expect(section).toContain("needs_approval");
    expect(section).toContain("计划文件");
    expect(section).toContain("计划审批请求");
    expect(section).toContain("不会创建可执行 task");
    expect(section).toContain("批准后系统才会根据已审批计划创建 task");
    expect(section).not.toContain("EnterPlanMode");
    expect(section).not.toContain("ExitPlanMode");
    expect(section).not.toContain(".context/plan/");
  });
});
