import { describe, expect, test } from "bun:test";
import {
  automationCreateInputSchema,
  automationUpdateInputSchema
} from "./schemas";
import type {
  AutomationCreateJobInput,
  AutomationUpdateJobInput
} from "@lume/shared";

describe("automation rpc schemas", () => {
  test("创建任务应接受管理页发送的完整自动化任务数据", () => {
    const input: AutomationCreateJobInput = {
      name: "PRD 初稿生成",
      description: "根据需求文档生成 PRD",
      prompt: "整理需求并输出 PRD",
      workspaceId: "workspace-1",
      schedule: { type: "manual" },
      triggerModes: ["manual", "chat"],
      toolResourceIds: ["file", "knowledge", "prd"],
      defaultModel: "GPT-5.4"
    };

    expect(automationCreateInputSchema.parse(input)).toEqual(input);
  });

  test("渲染进程不得经 RPC 铸造 source/systemAction（#647 P2-23）", () => {
    const parsed = automationCreateInputSchema.parse({
      name: "越权探测",
      prompt: "probe",
      schedule: { type: "manual" },
      source: "system",
      systemAction: "routine",
    });
    expect("source" in parsed).toBe(false);
    expect("systemAction" in parsed).toBe(false);

    const updated = automationUpdateInputSchema.parse({
      id: "job-1",
      source: "system",
      systemAction: "routine",
    });
    expect("source" in updated).toBe(false);
    expect("systemAction" in updated).toBe(false);
  });

  test("更新任务应接受展示元数据和 manual 调度", () => {
    const input: AutomationUpdateJobInput = {
      id: "job-1",
      name: "发布说明整理",
      description: "汇总迭代变更",
      prompt: "生成发布说明",
      schedule: { type: "manual" },
      triggerModes: ["manual", "schedule", "chat"],
      toolResourceIds: ["file", "code"],
      defaultModel: "继承当前模型"
    };

    expect(automationUpdateInputSchema.parse(input)).toEqual(input);
  });
});
