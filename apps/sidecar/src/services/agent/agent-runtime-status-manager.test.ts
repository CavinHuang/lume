import { describe, expect, test } from "bun:test";
import {
  AgentRuntimeStatusManager,
  getAgentRuntimeStatusManager,
  resetAgentRuntimeStatusManagerForTest
} from "./agent-runtime-status-manager";

describe("agent-runtime-status-manager", () => {
  test("收到 permission request 时应进入 awaiting_permission", () => {
    const manager = new AgentRuntimeStatusManager();
    manager.markAwaitingPermission("s1", {
      requestId: "req-1",
      toolUseId: "tool-1",
      toolName: "write"
    });

    expect(manager.get("s1")?.phase).toBe("awaiting_permission");
    expect(manager.get("s1")?.requestId).toBe("req-1");
    expect(manager.get("s1")?.toolName).toBe("write");
  });

  test("收到 ask user question 时应进入 awaiting_user_answer", () => {
    const manager = new AgentRuntimeStatusManager();
    manager.markAwaitingUserAnswer("s1", {
      toolUseId: "ask-1"
    });

    expect(manager.get("s1")?.phase).toBe("awaiting_user_answer");
    expect(manager.get("s1")?.toolUseId).toBe("ask-1");
  });

  test("相位变化应通知订阅者", () => {
    const manager = new AgentRuntimeStatusManager();
    const phases: string[] = [];
    const unsubscribe = manager.subscribe((status) => {
      phases.push(status.phase);
    });

    manager.markStreaming("s1");
    manager.markCompacting("s1");
    manager.markCompleted("s1");
    unsubscribe();

    expect(phases).toEqual(["streaming", "compacting", "completed"]);
  });

  test("单例应可重置用于测试", () => {
    resetAgentRuntimeStatusManagerForTest();
    const first = getAgentRuntimeStatusManager();
    const second = getAgentRuntimeStatusManager();
    expect(first).toBe(second);
  });
});
