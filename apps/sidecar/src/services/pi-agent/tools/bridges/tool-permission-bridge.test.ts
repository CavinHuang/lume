import { describe, expect, test } from "bun:test";
import {
  isToolAlwaysAllowed,
  listPendingToolPermissionRequests,
  markToolAlwaysAllowed,
  setToolPermissionApprovalSession,
  submitToolPermissionDecision,
  waitForToolPermissionDecision
} from "./tool-permission-bridge";

describe("tool-permission-bridge", () => {
  test("wait + submit 应返回用户决策", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "s1",
        requestId: "req-1",
        toolUseId: "tool-1",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        input: { command: "ls" }
      },
      new AbortController().signal,
      () => {}
    );
    const handled = submitToolPermissionDecision({
      threadId: "s1",
      requestId: "req-1",
      decision: "allow_once"
    });
    expect(handled).toBeTrue();
    const decision = await waitPromise;
    expect(decision).toBe("allow_once");
  });

  test("allow_always 应写入会话缓存", () => {
    expect(isToolAlwaysAllowed("s2", "Bash")).toBeFalse();
    markToolAlwaysAllowed("s2", "Bash");
    expect(isToolAlwaysAllowed("s2", "Bash")).toBeTrue();
  });

  test("应支持由父会话提交子会话权限决策", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "child-session",
        requestId: "req-proxy",
        toolUseId: "tool-proxy",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        input: { command: "echo hi" }
      },
      new AbortController().signal,
      () => {}
    );
    setToolPermissionApprovalSession("req-proxy", "parent-session");
    const handled = submitToolPermissionDecision({
      threadId: "parent-session",
      requestId: "req-proxy",
      decision: "allow_once"
    });
    expect(handled).toBeTrue();
    const decision = await waitPromise;
    expect(decision).toBe("allow_once");
  });

  test("listPending 应保留 subagentLabel，供 UI 展示子代理名称", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        threadId: "child-session",
        originThreadId: "child-session",
        subagentRunId: "run-1",
        subagentLabel: "探索工具能力边界",
        requestId: "req-label",
        toolUseId: "tool-label",
        toolName: "Bash",
        risk: "high",
        reason: "需要确认",
        input: { command: "echo hi" }
      },
      new AbortController().signal,
      () => {}
    );

    setToolPermissionApprovalSession("req-label", "parent-session");
    const pending = listPendingToolPermissionRequests();
    expect(pending[0]?.threadId).toBe("parent-session");
    expect(pending[0]?.subagentLabel).toBe("探索工具能力边界");

    submitToolPermissionDecision({
      threadId: "parent-session",
      requestId: "req-label",
      decision: "deny"
    });
    await waitPromise;
  });
});
