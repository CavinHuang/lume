import { describe, expect, test } from "bun:test";
import {
  isToolAlwaysAllowed,
  markToolAlwaysAllowed,
  submitToolPermissionDecision,
  waitForToolPermissionDecision
} from "./tool-permission-bridge";

describe("tool-permission-bridge", () => {
  test("wait + submit 应返回用户决策", async () => {
    const waitPromise = waitForToolPermissionDecision(
      {
        sessionId: "s1",
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
      sessionId: "s1",
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
});
