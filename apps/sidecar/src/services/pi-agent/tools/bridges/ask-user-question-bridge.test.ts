import { describe, expect, test } from "bun:test";
import {
  setAskUserQuestionApprovalSession,
  submitPiAskUserQuestionAnswers,
  waitForPiAskUserQuestionAnswers
} from "./ask-user-question-bridge";

describe("ask-user-question-bridge", () => {
  test("wait + submit 应成功返回答案", async () => {
    const toolUseId = "tool-use-1";
    const signal = new AbortController().signal;
    const waitPromise = waitForPiAskUserQuestionAnswers(
      "session-1",
      toolUseId,
      [{
        header: "问题1",
        question: "请选择",
        options: [
          { label: "A", description: "选项A" },
          { label: "B", description: "选项B" }
        ],
        multiSelect: false
      }],
      signal,
      () => {}
    );
    const handled = submitPiAskUserQuestionAnswers({
      threadId: "session-1",
      toolUseId,
      answers: { "问题1": "A" }
    });
    expect(handled).toBeTrue();
    const result = await waitPromise;
    expect(result.status).toBe("answered");
    expect(result.answers).toEqual({ "问题1": "A" });
  });

  test("等待超时应返回 timeout 状态", async () => {
    const previous = process.env.LUME_ASK_USER_QUESTION_TIMEOUT_MS;
    const previousAllowLow = process.env.LUME_ASK_USER_QUESTION_ALLOW_LOW_TIMEOUT;
    process.env.LUME_ASK_USER_QUESTION_TIMEOUT_MS = "30";
    process.env.LUME_ASK_USER_QUESTION_ALLOW_LOW_TIMEOUT = "1";
    try {
      const toolUseId = "tool-use-timeout";
      const signal = new AbortController().signal;
      const result = await waitForPiAskUserQuestionAnswers(
        "session-timeout",
        toolUseId,
        [{
          header: "问题1",
          question: "请选择",
          options: [
            { label: "A", description: "选项A" },
            { label: "B", description: "选项B" }
          ],
          multiSelect: false
        }],
        signal,
        () => {}
      );
      expect(result.status).toBe("timeout");
      expect(result.answers).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.LUME_ASK_USER_QUESTION_TIMEOUT_MS;
      } else {
        process.env.LUME_ASK_USER_QUESTION_TIMEOUT_MS = previous;
      }
      if (previousAllowLow === undefined) {
        delete process.env.LUME_ASK_USER_QUESTION_ALLOW_LOW_TIMEOUT;
      } else {
        process.env.LUME_ASK_USER_QUESTION_ALLOW_LOW_TIMEOUT = previousAllowLow;
      }
    }
  });

  test("应支持由父会话提交子会话 AskUserQuestion 答案", async () => {
    const toolUseId = "tool-use-proxy";
    const signal = new AbortController().signal;
    const waitPromise = waitForPiAskUserQuestionAnswers(
      "child-session",
      toolUseId,
      [{
        header: "问题1",
        question: "请选择",
        options: [
          { label: "A", description: "选项A" },
          { label: "B", description: "选项B" }
        ],
        multiSelect: false
      }],
      signal,
      () => {}
    );
    setAskUserQuestionApprovalSession(toolUseId, "parent-session");
    const handled = submitPiAskUserQuestionAnswers({
      threadId: "parent-session",
      toolUseId,
      answers: { "问题1": "B" }
    });
    expect(handled).toBeTrue();
    const result = await waitPromise;
    expect(result.status).toBe("answered");
    expect(result.answers).toEqual({ "问题1": "B" });
  });
});

