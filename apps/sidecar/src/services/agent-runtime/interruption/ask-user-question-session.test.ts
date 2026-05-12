import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeCoreSessionDir } from "../../pi-agent/runtime-core/session-store";
import { createFileBackedLumeInterruptionStore } from "./interruption-store";
import {
  listPendingPiAskUserQuestionRequests,
  setAskUserQuestionApprovalSession,
  submitPiAskUserQuestionAnswers,
  waitForPiAskUserQuestionAnswers
} from "./ask-user-question-session";

describe("ask-user-question-session", () => {
  const prevConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
  });

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

  test("listPending 应保留 subagentLabel，供 UI 展示子代理名称", async () => {
    const toolUseId = "tool-use-label";
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
      () => {},
      {
        originThreadId: "child-session",
        subagentRunId: "run-1",
        subagentLabel: "探索网络和搜索能力"
      }
    );

    setAskUserQuestionApprovalSession(toolUseId, "parent-session");
    const pending = listPendingPiAskUserQuestionRequests();
    expect(pending[0]?.threadId).toBe("parent-session");
    expect(pending[0]?.subagentLabel).toBe("探索网络和搜索能力");

    submitPiAskUserQuestionAnswers({
      threadId: "parent-session",
      toolUseId,
      canceled: true
    });
    await waitPromise;
  });

  test("应持久化 AskUserQuestion 并在回答后写入 resolution", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-ask-user-persist-"));
    const threadId = "ask-persist-thread";
    const waitPromise = waitForPiAskUserQuestionAnswers(
      threadId,
      "ask-persist",
      [{
        header: "选择",
        question: "继续吗？",
        options: [
          { label: "继续", description: "继续" },
          { label: "停止", description: "停止" }
        ],
        multiSelect: false
      }],
      new AbortController().signal,
      () => {}
    );

    const store = createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(threadId));
    expect((await store.listPendingByThread(threadId)).map((item) => item.id)).toEqual([
      "ask_user:ask-persist"
    ]);

    submitPiAskUserQuestionAnswers({
      threadId,
      toolUseId: "ask-persist",
      answers: { choice: "继续" }
    });
    expect(await waitPromise).toEqual({ status: "answered", answers: { choice: "继续" } });
    const resolved = await store.get("ask_user:ask-persist");
    expect(resolved?.status).toBe("approved");
    expect(resolved?.resolution?.decision).toBe("answer");
    expect(resolved?.resolution?.answer).toEqual({ choice: "继续" });
  });

  test("冷启动后没有 live resolver 时也应能取消落盘 AskUserQuestion", async () => {
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-ask-user-cold-"));
    const threadId = "ask-cold-thread";
    const store = createFileBackedLumeInterruptionStore(getRuntimeCoreSessionDir(threadId));
    await store.upsert({
      id: "ask_user:ask-cold",
      threadId,
      type: "ask_user",
      status: "pending",
      title: "需要用户回答",
      message: "继续吗？",
      payload: {
        threadId,
        toolUseId: "ask-cold",
        questions: [{
          header: "选择",
          question: "继续吗？",
          options: [
            { label: "继续", description: "继续" },
            { label: "停止", description: "停止" }
          ],
          multiSelect: false
        }]
      },
      source: {
        toolCallId: "ask-cold"
      },
      createdAt: "2026-04-29T00:00:00.000Z",
      updatedAt: "2026-04-29T00:00:00.000Z"
    });

    const handled = submitPiAskUserQuestionAnswers({
      threadId,
      toolUseId: "ask-cold",
      canceled: true
    });

    expect(handled).toBeTrue();
    expect((await store.get("ask_user:ask-cold"))?.status).toBe("rejected");
  });
});
