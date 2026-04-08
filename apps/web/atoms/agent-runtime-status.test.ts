import { describe, expect, test } from "bun:test";
import { createStore } from "jotai";
import type { AgentRuntimePhase, AgentRuntimeStatus } from "@lume/shared";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import {
  agentAskUserQuestionRequestsAtom,
  agentRunningThreadIdsAtom,
  agentRuntimeStatusesAtom,
  agentStreamingAtom,
  agentStreamingStatesAtom,
  agentToolPermissionRequestsAtom,
  currentAgentAskUserQuestionRequestAtom,
  currentAgentThreadIdAtom,
  currentAgentToolPermissionRequestAtom
} from "./agent-atoms";

describe("agent-runtime-status contract", () => {
  test("agent runtime status 应覆盖关键运行时阶段", () => {
    const phase: AgentRuntimePhase = "awaiting_permission";
    const status: AgentRuntimeStatus = {
      threadId: "session-1",
      phase,
      updatedAt: Date.now()
    };

    expect(status.phase).toBe("awaiting_permission");
  });

  test("应暴露 runtime status 相关 IPC 常量", () => {
    expect(AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS).toBe("agent:get-runtime-status");
    expect(AGENT_IPC_CHANNELS.RUNTIME_STATUS_CHANGED).toBe("agent:runtime-status-changed");
  });

  test("本地 running 为 true 时应始终标记为 streaming，即使残留的 runtime status 为 idle", () => {
    const store = createStore();
    store.set(currentAgentThreadIdAtom, "session-1");
    store.set(agentRuntimeStatusesAtom, new Map([
      ["session-1", { threadId: "session-1", phase: "idle", updatedAt: Date.now() }]
    ]));
    store.set(agentStreamingStatesAtom, new Map([
      ["session-1", { running: true, content: "", toolActivities: [], teammates: [] }]
    ]));

    // localStreaming 优先：前端在发送消息时立即设置 running=true，
    // 不应被尚未更新的残留 runtime status 覆盖，避免产生 UI 空白
    expect(store.get(agentStreamingAtom)).toBe(true);
  });

  test("共享 runtime status 缺失时应允许本地 running 兜底", () => {
    const store = createStore();
    store.set(currentAgentThreadIdAtom, "session-1");
    store.set(agentStreamingStatesAtom, new Map([
      ["session-1", { running: true, content: "", toolActivities: [], teammates: [] }]
    ]));

    expect(store.get(agentStreamingAtom)).toBe(true);
  });

  test("应按当前 session 读取共享 ask-user / tool-permission 请求", () => {
    const store = createStore();
    store.set(currentAgentThreadIdAtom, "session-1");
    store.set(agentAskUserQuestionRequestsAtom, new Map([
      ["session-1", { threadId: "session-1", toolUseId: "ask-1", questions: [] }]
    ]));
    store.set(agentToolPermissionRequestsAtom, new Map([
      ["session-1", { threadId: "session-1", requestId: "req-1", toolUseId: "tool-1", toolName: "write", risk: "high", reason: "r", input: {} }]
    ]));

    expect(store.get(currentAgentAskUserQuestionRequestAtom)?.toolUseId).toBe("ask-1");
    expect(store.get(currentAgentToolPermissionRequestAtom)?.requestId).toBe("req-1");
  });

  test("共享 runtime status 应保留交互上下文字段", () => {
    const store = createStore();
    store.set(currentAgentThreadIdAtom, "session-1");
    store.set(agentRuntimeStatusesAtom, new Map([
      ["session-1", {
        threadId: "session-1",
        phase: "awaiting_permission",
        interactiveKind: "tool_permission",
        requestId: "req-1",
        toolUseId: "tool-1",
        toolName: "write",
        originThreadId: "origin-1",
        subagentRunId: "run-1",
        updatedAt: Date.now()
      }]
    ]));

    const status = store.get(agentRuntimeStatusesAtom).get("session-1");
    expect(status?.interactiveKind).toBe("tool_permission");
    expect(status?.originThreadId).toBe("origin-1");
    expect(status?.subagentRunId).toBe("run-1");
  });

  test("running session ids 应优先使用共享 runtime status", () => {
    const store = createStore();
    store.set(agentRuntimeStatusesAtom, new Map([
      ["session-1", { threadId: "session-1", phase: "idle", updatedAt: Date.now() }]
    ]));
    store.set(agentStreamingStatesAtom, new Map([
      ["session-1", { running: true, content: "", toolActivities: [], teammates: [] }]
    ]));

    expect(store.get(agentRunningThreadIdsAtom).has("session-1")).toBe(false);
  });

  test("running session ids 在共享 runtime status 缺失时应回退到本地 streaming state", () => {
    const store = createStore();
    store.set(agentStreamingStatesAtom, new Map([
      ["session-1", { running: true, content: "", toolActivities: [], teammates: [] }]
    ]));

    expect(store.get(agentRunningThreadIdsAtom).has("session-1")).toBe(true);
  });
});


