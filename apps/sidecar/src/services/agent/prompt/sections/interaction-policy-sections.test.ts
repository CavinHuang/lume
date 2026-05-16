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
    expect(section).toContain("AskUserQuestion");
    expect(section).toContain("澄清需求");
    expect(section).toContain("不要用 AskUserQuestion 请求计划审批");
    expect(section).toContain("批准后系统才会根据已审批计划创建 task");
    expect(section).toContain("先探索，再调用 planner");
    expect(section).toContain("planner 只提供设计草案");
    expect(section).toContain("主线程负责审阅并调用 TaskContractWrite");
    expect(section).not.toContain("EnterPlanMode");
    expect(section).not.toContain("ExitPlanMode");
    expect(section).not.toContain(".context/plan/");
  });
});
