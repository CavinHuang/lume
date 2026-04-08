import { describe, expect, test } from "bun:test";
import { __testing, createSdkControlTools } from "./create-control-tools";

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

  test("自动化模式下应不注册 AskUserQuestion 工具", () => {
    const tools = createSdkControlTools({
      sessionId: "s3",
      emitAskUserQuestion: () => {},
      includeAskUserQuestion: false
    });
    const names = tools.map((tool) => tool.name);
    expect(names.includes("AskUserQuestion")).toBeFalse();
    expect(names.length).toBe(0);
  });
});
