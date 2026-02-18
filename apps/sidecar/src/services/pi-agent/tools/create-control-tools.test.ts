import { describe, expect, test } from "bun:test";
import { __testing, createPiControlTools } from "./create-control-tools";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("create-control-tools AskUserQuestion normalize", () => {
  test("应兼容字符串化 questions 并产出可渲染结构", () => {
    const sanitized = __testing.sanitizeAskUserQuestionInput({
      questions: JSON.stringify([
        "你想先做哪个方向？",
        {
          header: "决策",
          question: "请选择执行策略",
          options: ["保守", "激进"],
          multiSelect: false
        }
      ])
    });
    const normalized = __testing.normalizeAskUserQuestions(sanitized);

    expect(normalized.length).toBe(2);
    expect(normalized[0]?.header.length).toBeGreaterThan(0);
    expect(normalized[0]?.options.length).toBeGreaterThanOrEqual(2);
    expect(normalized[1]?.question).toBe("请选择执行策略");
  });

  test("重复 header 应自动去重，避免前端 answers 键冲突", () => {
    const sanitized = __testing.sanitizeAskUserQuestionInput({
      questions: [
        {
          header: "问题",
          question: "Q1",
          options: [{ label: "A", description: "A" }, { label: "B", description: "B" }]
        },
        {
          header: "问题",
          question: "Q2",
          options: [{ label: "A", description: "A" }, { label: "C", description: "C" }]
        }
      ]
    });
    const normalized = __testing.normalizeAskUserQuestions(sanitized);

    expect(normalized.length).toBe(2);
    expect(normalized[0]?.header).not.toBe(normalized[1]?.header);
  });

  test("应暴露 EnterPlanMode 工具并返回 plan 模式确认", async () => {
    const tools = createPiControlTools({
      sessionId: "s1",
      agentCwd: "/tmp",
      emitAskUserQuestion: () => {}
    });
    const enterPlan = tools.find((tool) => tool.name === "EnterPlanMode");
    expect(Boolean(enterPlan)).toBeTrue();
    if (!enterPlan) return;
    const result = await enterPlan.execute("tool-call-1", { reason: "需要先规划" }, new AbortController().signal);
    const details = result.details as { ok?: boolean; mode?: string };
    expect(details.ok).toBeTrue();
    expect(details.mode).toBe("plan");
  });

  test("ExitPlanMode 应保存计划并返回 allowedPrompts", async () => {
    const agentCwd = mkdtempSync(join(tmpdir(), "lume-plan-"));
    const tools = createPiControlTools({
      sessionId: "s2",
      agentCwd,
      emitAskUserQuestion: () => {}
    });
    const exitPlan = tools.find((tool) => tool.name === "ExitPlanMode");
    expect(Boolean(exitPlan)).toBeTrue();
    if (!exitPlan) return;
    const result = await exitPlan.execute("tool-call-2", {
      plan: "## 计划\n1. 读取代码\n2. 提交修改",
      allowedPrompts: [
        { tool: "Bash", prompt: "run tests" }
      ]
    }, new AbortController().signal);

    const details = result.details as {
      ok?: boolean;
      planPath?: string;
      plan?: string;
      allowedPrompts?: Array<{ tool: string; prompt: string }>;
    };
    expect(details.ok).toBeTrue();
    expect(typeof details.planPath).toBe("string");
    expect(details.plan?.includes("## 计划")).toBeTrue();
    expect(details.allowedPrompts?.length).toBe(1);
    expect(details.allowedPrompts?.[0]?.prompt).toBe("run tests");
    const content = readFileSync(details.planPath!, "utf-8");
    expect(content.includes("## 计划")).toBeTrue();
  });
});
