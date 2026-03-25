import { afterEach, describe, expect, test, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  getAgentSessionMessages,
  getAgentSessionMeta
} from "../../agent/agent-session-manager";
import { createOrResumeRuntimeCoreSessionManager } from "../runtime-core/session-store";
import {
  getSubagentRunRegistry,
  resetSubagentRunRegistryForTest
} from "../subagents/subagent-run-registry";
import type { AgentTool } from "@mariozechner/pi-agent-core";

mock.module("undici", () => ({
  EnvHttpProxyAgent: class {},
  setGlobalDispatcher: () => undefined
}));

mock.module("../run-pi-agent-message", () => ({
  runPiAgentMessage: async (
    input: unknown,
    emit: { onEvent: (event: unknown) => void; onComplete: () => void; onError?: (error: string) => void }
  ) => {
    const message = typeof (input as { userMessage?: unknown })?.userMessage === "string"
      ? ((input as { userMessage: string }).userMessage)
      : "";
    if (message.includes("[mock-slow]")) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (message.includes("[mock-error]")) {
      emit.onError?.("mock runtime error");
      return { status: "errored" as const };
    }
    emit.onEvent({
      type: "text_complete",
      text: "mock output",
      isIntermediate: false
    });
    emit.onComplete();
    return { status: "completed" as const };
  }
}));

mock.module("../runner/run", () => ({
  stopPiAgent: () => undefined
}));

afterEach(() => {
  resetSubagentRunRegistryForTest();
});

async function loadCreateOpenClawAlignedTools() {
  const mod = await import("./create-openclaw-aligned-tools");
  return mod.createOpenClawAlignedTools;
}

function resolveTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  return tool;
}

function appendTranscriptTextMessages(
  sessionId: string,
  messages: Array<{ role: "user" | "assistant"; content: string; model?: string; timestamp?: number }>
): void {
  const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), sessionId);
  for (const message of messages) {
    if (message.role === "user") {
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: message.content }],
        timestamp: message.timestamp ?? Date.now()
      });
      continue;
    }
    const resolvedModel = typeof message.model === "string" ? message.model.trim() : "";
    const [provider, ...restModel] = resolvedModel.split("/");
    sessionManager.appendMessage({
      role: "assistant",
      provider: provider && restModel.length > 0 ? provider : "unknown",
      model: restModel.length > 0 ? restModel.join("/") : (resolvedModel || "unknown"),
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: message.content }],
      timestamp: message.timestamp ?? Date.now()
    });
  }
}

describe("create-openclaw-aligned-tools", () => {
  test("agents_list 应返回可用于 sessions_spawn 的会话 agentId", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话", "channel-current");
      const target = createAgentSession("目标 Agent", "channel-target");
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const agentsListTool = resolveTool(tools as unknown as AgentTool[], "agents_list");
      const result = await agentsListTool.execute("tool-call-agents-list", {});
      const details = result.details as {
        agents?: Array<{ id?: string }>;
      };
      const ids = (details.agents ?? []).map((item) => item.id);
      expect(ids).toContain("lume");
      expect(ids).toContain(target.id);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_spawn 指定 agentId 时应生效并写入 run registry", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话", "channel-current");
      const target = createAgentSession("目标 Agent", "channel-target");
      appendTranscriptTextMessages(target.id, [{
        role: "assistant",
        content: "hello",
        timestamp: Date.now(),
        model: "model-target"
      }]);

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const spawnTool = resolveTool(tools as unknown as AgentTool[], "sessions_spawn");
      const result = await spawnTool.execute("tool-call-spawn-route", {
        task: "do routed work",
        agentId: target.id,
        runTimeoutSeconds: 3
      });
      const details = result.details as {
        status?: string;
        runId?: string;
        model?: string;
        requestedAgentId?: string;
        resolvedAgentId?: string;
      };
      expect(details.status).toBe("completed");
      expect(typeof details.runId).toBe("string");
      expect(details.model).toBe("unknown/model-target");
      expect(details.requestedAgentId).toBe(target.id);
      expect(details.resolvedAgentId).toBe(target.id);

      const runId = details.runId as string;
      const persisted = getSubagentRunRegistry().get(runId);
      expect(persisted).not.toBeNull();
      expect(persisted?.status).toBe("completed");
      expect(persisted?.requestedAgentId).toBe(target.id);
      expect(persisted?.resolvedAgentId).toBe(target.id);
      expect(persisted?.modelId).toBe("unknown/model-target");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("ENABLE_SUBAGENT_TEAM_V2=false 时应禁用 sessions_spawn", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousFlag = process.env.ENABLE_SUBAGENT_TEAM_V2;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    process.env.ENABLE_SUBAGENT_TEAM_V2 = "false";
    try {
      const current = createAgentSession("当前会话", "channel-current");
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const spawnTool = resolveTool(tools as unknown as AgentTool[], "sessions_spawn");
      const result = await spawnTool.execute("tool-call-spawn-disabled", {
        task: "should be blocked"
      });
      const details = result.details as {
        status?: string;
        error?: string;
      };
      expect(details.status).toBe("unavailable");
      expect(details.error).toContain("ENABLE_SUBAGENT_TEAM_V2=false");
    } finally {
      if (previousFlag === undefined) {
        delete process.env.ENABLE_SUBAGENT_TEAM_V2;
      } else {
        process.env.ENABLE_SUBAGENT_TEAM_V2 = previousFlag;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("subagents_list 应返回当前会话的 run 列表", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话", "channel-current");
      const child = createAgentSession("子会话", "channel-current");
      const registry = getSubagentRunRegistry();
      const run = registry.create({
        runId: randomUUID(),
        parentSessionId: current.id,
        childSessionId: child.id,
        task: "list me",
        cleanup: "keep",
        status: "running"
      });

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const listTool = resolveTool(tools as unknown as AgentTool[], "subagents_list");
      const result = await listTool.execute("tool-call-subagents-list", {});
      const details = result.details as {
        status?: string;
        count?: number;
        runs?: Array<{ runId?: string }>;
      };
      expect(details.status).toBe("ok");
      expect(details.count).toBe(1);
      expect(details.runs?.[0]?.runId).toBe(run.runId);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("subagents_kill 应终止当前会话拥有的运行中 run", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话", "channel-current");
      const child = createAgentSession("子会话", "channel-current");
      const registry = getSubagentRunRegistry();
      const runId = randomUUID();
      registry.create({
        runId,
        parentSessionId: current.id,
        childSessionId: child.id,
        task: "kill me",
        cleanup: "keep",
        status: "running"
      });

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const killTool = resolveTool(tools as unknown as AgentTool[], "subagents_kill");
      const result = await killTool.execute("tool-call-subagents-kill", {
        runId
      });
      const details = result.details as {
        status?: string;
        killed?: boolean;
      };
      expect(details.status).toBe("ok");
      expect(details.killed).toBe(true);
      expect(getSubagentRunRegistry().get(runId)?.status).toBe("canceled");
      expect(getSubagentRunRegistry().get(runId)?.outcome?.errorCode).toBe("SUBAGENT_CANCELED");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("subagents_send 应向受控子任务会话发送指令", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话", "channel-current");
      const child = createAgentSession("子会话", "channel-current");
      const registry = getSubagentRunRegistry();
      const runId = randomUUID();
      registry.create({
        runId,
        parentSessionId: current.id,
        childSessionId: child.id,
        task: "send me",
        cleanup: "keep",
        status: "running",
        channelId: "channel-current",
        modelId: "model-send"
      });

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const sendTool = resolveTool(tools as unknown as AgentTool[], "subagents_send");
      const result = await sendTool.execute("tool-call-subagents-send", {
        runId,
        message: "follow up",
        timeoutSeconds: 3
      });
      const details = result.details as {
        status?: string;
        runId?: string;
      };
      expect(details.status).toBe("completed");
      expect(details.runId).toBe(runId);
      expect(getSubagentRunRegistry().get(runId)?.status).toBe("completed");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("subagents_steer 应取消旧 run 并创建新 run", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话", "channel-current");
      const child = createAgentSession("子会话", "channel-current");
      const registry = getSubagentRunRegistry();
      const oldRunId = randomUUID();
      registry.create({
        runId: oldRunId,
        parentSessionId: current.id,
        childSessionId: child.id,
        task: "old task",
        cleanup: "keep",
        status: "running",
        channelId: "channel-current",
        modelId: "model-steer"
      });

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const steerTool = resolveTool(tools as unknown as AgentTool[], "subagents_steer");
      const result = await steerTool.execute("tool-call-subagents-steer", {
        runId: oldRunId,
        message: "new direction",
        timeoutSeconds: 0
      });
      const details = result.details as {
        status?: string;
        runId?: string;
        replacedRunId?: string;
      };
      expect(details.status).toBe("accepted");
      expect(details.replacedRunId).toBe(oldRunId);
      expect(typeof details.runId).toBe("string");
      expect(details.runId).not.toBe(oldRunId);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getSubagentRunRegistry().get(oldRunId)?.status).toBe("canceled");
      expect(getSubagentRunRegistry().get(details.runId as string)).not.toBeNull();
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_spawn 应拒绝超过扇出限制", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousFanout = process.env.LUME_SUBAGENT_MAX_FANOUT;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    process.env.LUME_SUBAGENT_MAX_FANOUT = "1";
    try {
      const current = createAgentSession("当前会话", "channel-current");
      const child = createAgentSession("子会话", "channel-current");
      getSubagentRunRegistry().create({
        runId: randomUUID(),
        parentSessionId: current.id,
        childSessionId: child.id,
        task: "already running",
        cleanup: "keep",
        status: "running"
      });

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const spawnTool = resolveTool(tools as unknown as AgentTool[], "sessions_spawn");
      const result = await spawnTool.execute("tool-call-spawn-fanout-limit", {
        task: "another child"
      });
      const details = result.details as { status?: string; error?: string };
      expect(details.status).toBe("forbidden");
      expect(details.error).toContain("扇出超限");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
      if (previousFanout === undefined) {
        delete process.env.LUME_SUBAGENT_MAX_FANOUT;
      } else {
        process.env.LUME_SUBAGENT_MAX_FANOUT = previousFanout;
      }
    }
  });

  test("sessions_spawn 应拒绝超过深度限制", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousDepth = process.env.LUME_SUBAGENT_MAX_DEPTH;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    process.env.LUME_SUBAGENT_MAX_DEPTH = "1";
    try {
      const root = createAgentSession("根会话", "channel-current");
      const current = createAgentSession("当前会话", "channel-current");
      getSubagentRunRegistry().create({
        runId: randomUUID(),
        parentSessionId: root.id,
        rootSessionId: root.id,
        depth: 1,
        childSessionId: current.id,
        task: "depth parent",
        cleanup: "keep",
        status: "running"
      });

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const spawnTool = resolveTool(tools as unknown as AgentTool[], "sessions_spawn");
      const result = await spawnTool.execute("tool-call-spawn-depth-limit", {
        task: "too deep"
      });
      const details = result.details as { status?: string; error?: string };
      expect(details.status).toBe("forbidden");
      expect(details.error).toContain("深度超限");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
      if (previousDepth === undefined) {
        delete process.env.LUME_SUBAGENT_MAX_DEPTH;
      } else {
        process.env.LUME_SUBAGENT_MAX_DEPTH = previousDepth;
      }
    }
  });

  test("sessions_spawn 异步完成应按 deliverySessionKey 回传 completion", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const parent = createAgentSession("父会话", "channel-current");
      const inbox = createAgentSession("收件会话", "channel-current");
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: parent.id
      });
      const spawnTool = resolveTool(tools as unknown as AgentTool[], "sessions_spawn");
      const result = await spawnTool.execute("tool-call-spawn-delivery", {
        task: "async task",
        runTimeoutSeconds: 0,
        model: "model-delivery",
        deliverySessionKey: inbox.id,
        thread: true
      });
      const details = result.details as {
        status?: string;
        runId?: string;
        deliverySessionKey?: string;
        threadBound?: boolean;
      };
      expect(details.status).toBe("accepted");
      expect(details.deliverySessionKey).toBe(inbox.id);
      expect(details.threadBound).toBe(true);
      const runId = details.runId as string;

      await new Promise((resolve) => setTimeout(resolve, 0));

      const run = getSubagentRunRegistry().get(runId);
      expect(run?.announceStatus).toBe("delivered");
      expect(run?.deliverySessionId).toBe(inbox.id);

      const inboxMessages = getAgentSessionMessages(inbox.id);
      const parentMessages = getAgentSessionMessages(parent.id);
      expect(inboxMessages.some((item) => item.metadata?.subagentAnnounce === true)).toBe(true);
      expect(parentMessages.some((item) => item.metadata?.subagentAnnounce === true)).toBe(false);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("subagent 会话应拒绝 sessions_spawn", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: "agent:main:subagent:test"
      });
      const spawnTool = resolveTool(tools as unknown as AgentTool[], "sessions_spawn");
      const result = await spawnTool.execute("tool-call-1", { task: "do work" });
      const details = result.details as { status?: string; error?: string };
      expect(details.status).toBe("error");
      expect(details.error).toContain("not allowed from sub-agent sessions");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("subagent 会话应拒绝 sessions_send 与 agents_list", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: "agent:main:subagent:test"
      });
      const sendTool = resolveTool(tools as unknown as AgentTool[], "sessions_send");
      const sendResult = await sendTool.execute("tool-call-send", {
        sessionKey: "main",
        message: "hello"
      });
      const sendDetails = sendResult.details as { status?: string; error?: string };
      expect(sendDetails.status).toBe("error");
      expect(sendDetails.error).toContain("sessions_send is not allowed from sub-agent sessions");

      const agentsListTool = resolveTool(tools as unknown as AgentTool[], "agents_list");
      const listResult = await agentsListTool.execute("tool-call-list", {});
      const listDetails = listResult.details as { status?: string; error?: string };
      expect(listDetails.status).toBe("error");
      expect(listDetails.error).toContain("agents_list is not allowed from sub-agent sessions");

      const deleteTool = resolveTool(tools as unknown as AgentTool[], "sessions_delete");
      const deleteResult = await deleteTool.execute("tool-call-delete", {
        sessionKey: "main"
      });
      const deleteDetails = deleteResult.details as { status?: string; error?: string };
      expect(deleteDetails.status).toBe("error");
      expect(deleteDetails.error).toContain("sessions_delete is not allowed from sub-agent sessions");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_history 未传 sessionKey/label 时应返回错误", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话");
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const historyTool = resolveTool(tools as unknown as AgentTool[], "sessions_history");
      const result = await historyTool.execute("tool-call-2", {});
      const details = result.details as { status?: string; error?: string };
      expect(details.status).toBe("error");
      expect(details.error).toContain("Either sessionKey or label is required");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_history 应支持通过 label 读取目标会话历史", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话");
      const target = createAgentSession("目标会话");
      appendTranscriptTextMessages(target.id, [
        {
          role: "user",
          content: "hello",
          timestamp: Date.now()
        },
        {
          role: "assistant",
          content: "world",
          timestamp: Date.now(),
          model: "test/model"
        }
      ]);

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const historyTool = resolveTool(tools as unknown as AgentTool[], "sessions_history");
      const result = await historyTool.execute("tool-call-3", {
        label: "目标会话",
        limit: 10
      });
      const details = result.details as {
        status?: string;
        sessionKey?: string;
        count?: number;
        messages?: Array<{ content?: string }>;
      };
      expect(details.status).toBe("ok");
      expect(details.sessionKey).toBe(target.id);
      expect(details.count).toBe(2);
      expect(details.messages?.[0]?.content).toBe("hello");
      expect(details.messages?.[1]?.content).toBe("world");
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_delete 应支持通过 label 删除目标会话", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话");
      const target = createAgentSession("目标会话");
      appendTranscriptTextMessages(target.id, [{
        role: "user",
        content: "待删除消息",
        timestamp: Date.now()
      }]);

      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const deleteTool = resolveTool(tools as unknown as AgentTool[], "sessions_delete");
      const result = await deleteTool.execute("tool-call-4", {
        label: "目标会话"
      });
      const details = result.details as {
        status?: string;
        deleted?: boolean;
        sessionKey?: string;
      };
      expect(details.status).toBe("ok");
      expect(details.deleted).toBe(true);
      expect(details.sessionKey).toBe(target.id);
      expect(getAgentSessionMeta(target.id)).toBeUndefined();
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_delete 不允许删除当前会话", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话");
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const deleteTool = resolveTool(tools as unknown as AgentTool[], "sessions_delete");
      const result = await deleteTool.execute("tool-call-5", {
        sessionKey: current.id
      });
      const details = result.details as {
        status?: string;
        error?: string;
      };
      expect(details.status).toBe("error");
      expect(details.error).toContain("不能删除当前会话");
      expect(getAgentSessionMeta(current.id)?.id).toBe(current.id);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_delete 应支持通过 sessionKeys 批量删除", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话");
      const targetA = createAgentSession("目标会话-A");
      const targetB = createAgentSession("目标会话-B");
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const deleteTool = resolveTool(tools as unknown as AgentTool[], "sessions_delete");
      const result = await deleteTool.execute("tool-call-6", {
        sessionKeys: [targetA.id, targetB.id]
      });
      const details = result.details as {
        status?: string;
        deleted?: boolean;
        deletedCount?: number;
        sessionKeys?: string[];
      };
      expect(details.status).toBe("ok");
      expect(details.deleted).toBe(true);
      expect(details.deletedCount).toBe(2);
      expect(details.sessionKeys).toEqual([targetA.id, targetB.id]);
      expect(getAgentSessionMeta(targetA.id)).toBeUndefined();
      expect(getAgentSessionMeta(targetB.id)).toBeUndefined();
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_delete 输入 label 时应删除所有同名会话", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话");
      const targetA = createAgentSession("同名会话");
      const targetB = createAgentSession("同名会话");
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const deleteTool = resolveTool(tools as unknown as AgentTool[], "sessions_delete");
      const result = await deleteTool.execute("tool-call-7", {
        label: "同名会话"
      });
      const details = result.details as {
        status?: string;
        deleted?: boolean;
        deletedCount?: number;
        sessionKeys?: string[];
      };
      expect(details.status).toBe("ok");
      expect(details.deleted).toBe(true);
      expect(details.deletedCount).toBe(2);
      expect([...(details.sessionKeys ?? [])].sort()).toEqual([targetA.id, targetB.id].sort());
      expect(getAgentSessionMeta(targetA.id)).toBeUndefined();
      expect(getAgentSessionMeta(targetB.id)).toBeUndefined();
      expect(getAgentSessionMeta(current.id)?.id).toBe(current.id);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("sessions_delete 批量删除包含当前会话时应拒绝", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话");
      const target = createAgentSession("目标会话");
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({
        sessionId: current.id
      });
      const deleteTool = resolveTool(tools as unknown as AgentTool[], "sessions_delete");
      const result = await deleteTool.execute("tool-call-8", {
        sessionKeys: [target.id, current.id]
      });
      const details = result.details as {
        status?: string;
        error?: string;
      };
      expect(details.status).toBe("error");
      expect(details.error).toContain("不能删除当前会话");
      expect(getAgentSessionMeta(current.id)?.id).toBe(current.id);
      expect(getAgentSessionMeta(target.id)?.id).toBe(target.id);
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search 应解析 duckduckgo HTML 结果", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    globalThis.fetch = mock(async () =>
      new Response(
        `
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1&amp;rut=abc">Example Title</a>
        <a class="result__snippet">This is a description</a>
      `,
        { status: 200, headers: { "content-type": "text/html" } }
      )
    ) as unknown as typeof fetch;

    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web", {
        query: "example"
      });
      const details = result.details as {
        provider?: string;
        count?: number;
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      };
      expect(details.provider).toBe("duckduckgo");
      expect(details.count).toBe(1);
      expect(details.results?.[0]?.title).toBe("Example Title");
      expect(details.results?.[0]?.url).toBe("https://example.com/path?a=1");
      expect(details.results?.[0]?.snippet).toContain("description");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search brave 缺少 key 时应返回明确错误", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    delete process.env.BRAVE_SEARCH_API_KEY;
    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-brave", {
        query: "example",
        provider: "brave"
      });
      const details = result.details as { error?: string };
      expect(details.error).toContain("braveApiKey");
    } finally {
      if (previousBraveKey === undefined) {
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search tavily 缺少 key 时应返回明确错误", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    delete process.env.TAVILY_API_KEY;
    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-tavily", {
        query: "example",
        provider: "tavily"
      });
      const details = result.details as { error?: string };
      expect(details.error).toContain("tavilyApiKey");
    } finally {
      if (previousTavilyKey === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = previousTavilyKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search duckduckgo 超时应返回结构化错误码", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.TAVILY_API_KEY;
    globalThis.fetch = mock(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;

    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-timeout", {
        query: "timeout case"
      });
      const details = result.details as { code?: string; error?: string; provider?: string };
      expect(details.code).toBe("WEB_SEARCH_TIMEOUT");
      expect(details.provider).toBe("duckduckgo");
      expect(details.error).toContain("请求超时");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousBraveKey === undefined) {
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
      }
      if (previousTavilyKey === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = previousTavilyKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search duckduckgo 失败时应自动降级到 brave", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    process.env.BRAVE_SEARCH_API_KEY = "test-key";

    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount += 1;
      if (callCount <= 4) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Brave Result",
                url: "https://example.org",
                description: "fallback result"
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-fallback", {
        query: "fallback case"
      });
      const details = result.details as {
        provider?: string;
        fallbackFrom?: string;
        count?: number;
        results?: Array<{ title?: string }>;
      };
      expect(details.provider).toBe("brave");
      expect(details.fallbackFrom).toBe("duckduckgo");
      expect(details.count).toBe(1);
      expect(details.results?.[0]?.title).toBe("Brave Result");
      expect(callCount).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousBraveKey === undefined) {
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("web_search duckduckgo 失败且 brave 不可用时应降级到 tavily", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const previousBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    const previousTavilyKey = process.env.TAVILY_API_KEY;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    delete process.env.BRAVE_SEARCH_API_KEY;
    process.env.TAVILY_API_KEY = "test-tavily";

    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount += 1;
      if (callCount <= 4) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Tavily Result",
              url: "https://example.net",
              content: "fallback from tavily"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    try {
      const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
      const tools = createOpenClawAlignedTools({ sessionId: "agent:main:test" });
      const webSearchTool = resolveTool(tools as unknown as AgentTool[], "web_search");
      const result = await webSearchTool.execute("tool-call-web-tavily-fallback", {
        query: "fallback tavily case",
        braveApiKey: ""
      });
      const details = result.details as {
        provider?: string;
        fallbackFrom?: string;
        count?: number;
        results?: Array<{ title?: string }>;
      };
      expect(details.provider).toBe("tavily");
      expect(details.fallbackFrom).toBe("duckduckgo");
      expect(details.count).toBe(1);
      expect(details.results?.[0]?.title).toBe("Tavily Result");
      expect(callCount).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousBraveKey === undefined) {
        delete process.env.BRAVE_SEARCH_API_KEY;
      } else {
        process.env.BRAVE_SEARCH_API_KEY = previousBraveKey;
      }
      if (previousTavilyKey === undefined) {
        delete process.env.TAVILY_API_KEY;
      } else {
        process.env.TAVILY_API_KEY = previousTavilyKey;
      }
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });
});
