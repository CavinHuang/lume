import { describe, expect, test } from "bun:test";
import { buildPlanModeSection } from "./interaction-policy-sections";

describe("interaction-policy-sections", () => {
  test("plan mode describes a read-only plan without a separate Task approval flow", () => {
    const section = buildPlanModeSection();

    expect(section).toContain("Markdown 计划");
    expect(section).toContain("Markdown");
    expect(section).toContain("Task 不需要单独审批");
    expect(section).toContain("AskUserQuestion");
    expect(section).toContain("澄清需求");
    expect(section).toContain("用户决定继续后按正常流程执行");
    expect(section).toContain("先探索，再调用 planner");
    expect(section).toContain("planner 只提供设计草案，不修改文件、不管理 Task");
    expect(section).toContain("主线程负责审阅 planner 结果");
    expect(section).not.toContain("EnterPlanMode");
    expect(section).not.toContain("ExitPlanMode");
    expect(section).not.toContain(".context/plan/");
  });
});
