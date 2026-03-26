import { describe, expect, test } from "bun:test";
import type { AgentAskUserQuestionRequest } from "@lume/shared";
import {
  ASK_USER_OTHER_OPTION,
  buildAskUserQuestionAnswers
} from "./agent-interactive-requests";

describe("agent-interactive-requests", () => {
  test("单选问题应返回选中项文本", () => {
    const request: AgentAskUserQuestionRequest = {
      sessionId: "session-1",
      toolUseId: "tool-1",
      questions: [
        {
          header: "语言",
          question: "选择语言",
          options: [
            { label: "中文", description: "" },
            { label: "English", description: "" }
          ],
          multiSelect: false
        }
      ]
    };

    expect(buildAskUserQuestionAnswers(request, {
      语言: {
        selected: ["中文"],
        otherText: ""
      }
    })).toEqual({
      answers: {
        语言: "中文"
      }
    });
  });

  test("多选问题应合并 other 文本并用逗号拼接", () => {
    const request: AgentAskUserQuestionRequest = {
      sessionId: "session-1",
      toolUseId: "tool-1",
      questions: [
        {
          header: "能力",
          question: "选择能力",
          options: [
            { label: "搜索", description: "" },
            { label: "编码", description: "" }
          ],
          multiSelect: true
        }
      ]
    };

    expect(buildAskUserQuestionAnswers(request, {
      能力: {
        selected: ["搜索", ASK_USER_OTHER_OPTION],
        otherText: "调试"
      }
    })).toEqual({
      answers: {
        能力: "搜索, 调试"
      }
    });
  });

  test("缺少答案时应返回具体 header 错误", () => {
    const request: AgentAskUserQuestionRequest = {
      sessionId: "session-1",
      toolUseId: "tool-1",
      questions: [
        {
          header: "语言",
          question: "选择语言",
          options: [{ label: "中文", description: "" }],
          multiSelect: false
        }
      ]
    };

    expect(buildAskUserQuestionAnswers(request, {
      语言: {
        selected: [],
        otherText: ""
      }
    })).toEqual({
      error: "请先回答「语言」"
    });
  });
});
