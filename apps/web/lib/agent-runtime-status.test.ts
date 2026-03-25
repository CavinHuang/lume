import { describe, expect, test } from "bun:test";
import type { AgentRuntimeStatus } from "@lume/shared";
import {
  isAgentRuntimeAwaitingInput,
  isAgentRuntimePhaseActive,
  isAgentRuntimeStatusActive,
  resolveAgentBusyState
} from "./agent-runtime-status";

describe("agent runtime status helpers", () => {
  test("活跃相位应与共享运行态契约保持一致", () => {
    expect(isAgentRuntimePhaseActive("streaming")).toBe(true);
    expect(isAgentRuntimePhaseActive("awaiting_permission")).toBe(true);
    expect(isAgentRuntimePhaseActive("awaiting_user_answer")).toBe(true);
    expect(isAgentRuntimePhaseActive("compacting")).toBe(true);
    expect(isAgentRuntimePhaseActive("idle")).toBe(false);
    expect(isAgentRuntimePhaseActive("completed")).toBe(false);
    expect(isAgentRuntimePhaseActive("errored")).toBe(false);
  });

  test("共享 runtime status 存在时应优先信任共享状态", () => {
    const idleStatus: AgentRuntimeStatus = {
      sessionId: "session-1",
      phase: "idle",
      updatedAt: Date.now()
    };

    expect(isAgentRuntimeStatusActive(idleStatus)).toBe(false);
    expect(resolveAgentBusyState(idleStatus, true)).toBe(false);
  });

  test("共享 runtime status 缺失时应回退到本地 streaming", () => {
    expect(resolveAgentBusyState(null, true)).toBe(true);
    expect(resolveAgentBusyState(undefined, false)).toBe(false);
  });

  test("awaiting 相位应被识别为交互输入等待态", () => {
    expect(isAgentRuntimeAwaitingInput({
      sessionId: "session-1",
      phase: "awaiting_permission",
      updatedAt: Date.now()
    })).toBe(true);
    expect(isAgentRuntimeAwaitingInput({
      sessionId: "session-1",
      phase: "awaiting_user_answer",
      updatedAt: Date.now()
    })).toBe(true);
    expect(isAgentRuntimeAwaitingInput({
      sessionId: "session-1",
      phase: "streaming",
      updatedAt: Date.now()
    })).toBe(false);
  });
});
