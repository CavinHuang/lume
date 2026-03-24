import { describe, expect, test } from "bun:test";
import { createStore } from "jotai";
import type { AgentRuntimePhase, AgentRuntimeStatus } from "@lume/shared";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import {
  agentAskUserQuestionRequestsAtom,
  agentRunningSessionIdsAtom,
  agentRuntimeStatusesAtom,
  agentStreamingAtom,
  agentStreamingStatesAtom,
  agentToolPermissionRequestsAtom,
  currentAgentAskUserQuestionRequestAtom,
  currentAgentSessionIdAtom,
  currentAgentToolPermissionRequestAtom
} from "./agent-atoms";

describe("agent-runtime-status contract", () => {
  test("agent runtime status 应覆盖关键运行时阶段", () => {
    const phase: AgentRuntimePhase = "awaiting_permission";
    const status: AgentRuntimeStatus = {
      sessionId: "session-1",
      phase,
      updatedAt: Date.now()
    };

    expect(status.phase).toBe("awaiting_permission");
  });

  test("应暴露 runtime status 相关 IPC 常量", () => {
    expect(AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS).toBe("agent:get-runtime-status");
    expect(AGENT_IPC_CHANNELS.RUNTIME_STATUS_CHANGED).toBe("agent:runtime-status-changed");
  });

  test("共享 runtime status 为 idle 时应允许本地 running 兜底", () => {
    const store = createStore();
    store.set(currentAgentSessionIdAtom, "session-1");
    store.set(agentRuntimeStatusesAtom, new Map([
      ["session-1", { sessionId: "session-1", phase: "idle", updatedAt: Date.now() }]
    ]));
    store.set(agentStreamingStatesAtom, new Map([
      ["session-1", { running: true, content: "", toolActivities: [], teammates: [] }]
    ]));

    expect(store.get(agentStreamingAtom)).toBe(true);
  });

  test("应按当前 session 读取共享 ask-user / tool-permission 请求", () => {
    const store = createStore();
    store.set(currentAgentSessionIdAtom, "session-1");
    store.set(agentAskUserQuestionRequestsAtom, new Map([
      ["session-1", { sessionId: "session-1", toolUseId: "ask-1", questions: [] }]
    ]));
    store.set(agentToolPermissionRequestsAtom, new Map([
      ["session-1", { sessionId: "session-1", requestId: "req-1", toolUseId: "tool-1", toolName: "write", risk: "high", reason: "r", input: {} }]
    ]));

    expect(store.get(currentAgentAskUserQuestionRequestAtom)?.toolUseId).toBe("ask-1");
    expect(store.get(currentAgentToolPermissionRequestAtom)?.requestId).toBe("req-1");
  });

  test("running session ids 应优先使用共享 runtime status", () => {
    const store = createStore();
    store.set(agentRuntimeStatusesAtom, new Map([
      ["session-1", { sessionId: "session-1", phase: "awaiting_permission", updatedAt: Date.now() }]
    ]));

    expect(store.get(agentRunningSessionIdsAtom).has("session-1")).toBe(true);
  });
});
