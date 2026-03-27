import { describe, expect, test } from "bun:test";
import type { AgentRuntimeStatus } from "@lume/shared";
import {
  formatAgentRuntimeStatusHint,
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

  test("localStreaming 为 true 时应始终返回 busy，即使 runtime status 为 idle/completed", () => {
    const idleStatus: AgentRuntimeStatus = {
      sessionId: "session-1",
      phase: "idle",
      updatedAt: Date.now()
    };
    const completedStatus: AgentRuntimeStatus = {
      sessionId: "session-1",
      phase: "completed",
      updatedAt: Date.now()
    };

    expect(isAgentRuntimeStatusActive(idleStatus)).toBe(false);
    // localStreaming 优先：前端已发送消息并设 running=true，不应被残留的 runtime status 覆盖
    expect(resolveAgentBusyState(idleStatus, true)).toBe(true);
    expect(resolveAgentBusyState(completedStatus, true)).toBe(true);
    expect(resolveAgentBusyState(null, true)).toBe(true);
  });

  test("localStreaming 为 false 时应信任 runtime status", () => {
    const streamingStatus: AgentRuntimeStatus = {
      sessionId: "session-1",
      phase: "streaming",
      updatedAt: Date.now()
    };

    expect(resolveAgentBusyState(streamingStatus, false)).toBe(true);
    expect(resolveAgentBusyState(null, false)).toBe(false);
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

  test("应格式化 awaiting_permission 的共享状态提示", () => {
    expect(formatAgentRuntimeStatusHint({
      sessionId: "session-1",
      phase: "awaiting_permission",
      interactiveKind: "tool_permission",
      toolName: "write",
      originSessionId: "origin-1",
      subagentRunId: "run-1",
      updatedAt: Date.now()
    })).toBe("等待工具权限确认 · 工具: write · 来源会话: origin-1 · Run: run-1");
  });

  test("应格式化 awaiting_user_answer 的共享状态提示", () => {
    expect(formatAgentRuntimeStatusHint({
      sessionId: "session-1",
      phase: "awaiting_user_answer",
      interactiveKind: "ask_user_question",
      originSessionId: "origin-2",
      updatedAt: Date.now()
    })).toBe("等待用户回答问题 · 来源会话: origin-2");
  });
});
