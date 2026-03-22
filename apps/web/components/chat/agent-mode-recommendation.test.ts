import { describe, expect, test } from "bun:test";
import type { ChatToolActivity } from "@lume/shared";
import { extractAgentModeRecommendation } from "./agent-mode-recommendation";

function makeResultActivity(result: string, isError?: boolean): ChatToolActivity {
  return {
    type: "result",
    toolName: "suggest_agent_mode",
    toolCallId: "call-1",
    result,
    isError
  };
}

describe("extractAgentModeRecommendation", () => {
  test("应解析有效推荐结果", () => {
    const activities: ChatToolActivity[] = [
      {
        type: "start",
        toolName: "suggest_agent_mode",
        toolCallId: "call-1"
      },
      makeResultActivity(JSON.stringify({
        type: "agent_recommendation",
        reason: "任务复杂",
        suggestedPrompt: "请继续执行该任务"
      }))
    ];

    const result = extractAgentModeRecommendation(activities);
    expect(result).toEqual({
      reason: "任务复杂",
      suggestedPrompt: "请继续执行该任务"
    });
  });

  test("错误结果不应触发推荐", () => {
    const result = extractAgentModeRecommendation([
      makeResultActivity(JSON.stringify({
        type: "agent_recommendation",
        reason: "任务复杂",
        suggestedPrompt: "请继续执行该任务"
      }), true)
    ]);
    expect(result).toBeNull();
  });

  test("非法 JSON 不应触发推荐", () => {
    const result = extractAgentModeRecommendation([
      makeResultActivity("not-json")
    ]);
    expect(result).toBeNull();
  });

  test("应优先取最新有效结果", () => {
    const result = extractAgentModeRecommendation([
      makeResultActivity(JSON.stringify({
        type: "agent_recommendation",
        reason: "旧推荐",
        suggestedPrompt: "旧 prompt"
      })),
      {
        type: "result",
        toolName: "web_search",
        toolCallId: "call-2",
        result: "ok"
      },
      makeResultActivity(JSON.stringify({
        type: "agent_recommendation",
        reason: "新推荐",
        suggestedPrompt: "新 prompt"
      }))
    ]);
    expect(result).toEqual({
      reason: "新推荐",
      suggestedPrompt: "新 prompt"
    });
  });
});
