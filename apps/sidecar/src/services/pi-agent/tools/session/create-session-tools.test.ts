import { afterEach, describe, expect, test, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  getAgentSessionMessages,
  getAgentSessionMeta
} from "../../../agent/agent-session-manager";
import { createOrResumeRuntimeCoreSessionManager } from "../../runtime-core/session-store";
import {
  getSubagentRunRegistry,
  resetSubagentRunRegistryForTest
} from "../../../agent/subagents/subagent-run-registry";
import type { ToolDefinition } from "@lume/agent-sdk";

mock.module("undici", () => ({
  EnvHttpProxyAgent: class {},
  setGlobalDispatcher: () => undefined
}));

mock.module("../../runtime-core/attempt", () => ({
  runPiAgent: async (
    params: { input: { userMessage?: string } },
    emit: { onSdkMessage: (message: unknown) => void; onComplete: () => void; onError?: (error: string) => void }
  ) => {
    const message = typeof params.input?.userMessage === "string"
      ? params.input.userMessage
      : "";
    if (message.includes("[mock-slow]")) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (message.includes("[mock-error]")) {
      emit.onError?.("mock runtime error");
      return { status: "errored" as const };
    }
    emit.onSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "mock output" }]
      }
    });
    emit.onComplete();
    return { status: "completed" as const };
  },
  stopPiAgent: () => undefined
}));

afterEach(() => {
  resetSubagentRunRegistryForTest();
});

async function loadCreateSessionTools() {
  const mod = await import("./create-session-tools");
  return mod.createSdkSessionTools;
}

const loadCreateSdkSessionTools = loadCreateSessionTools;

function resolveTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  return tool;
}

async function callTool(tool: ToolDefinition, input: Record<string, unknown>): Promise<unknown> {
  const result = await tool.call(input, { cwd: process.cwd(), abortSignal: new AbortController().signal });
  const payload = (result as { data?: unknown; content?: unknown }).data ?? (result as { content?: unknown }).content;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return payload;
    }
  }
  return (payload ?? {}) as Record<string, unknown>;
}

function appendTranscriptTextMessages(
  threadId: string,
  messages: Array<{ role: "user" | "assistant"; content: string; model?: string; timestamp?: number }>
): void {
  const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), threadId);
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

describe("create-session-tools", () => {
  test("agents_list 应返回可用于 sessions_spawn 的会话 agentId", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    try {
      const current = createAgentSession("当前会话", "channel-current");
      const target = createAgentSession("目标 Agent", "channel-target");
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const agentsListTool = resolveTool(tools, "agents_list");
      const result = await callTool(agentsListTool, {});
      const details = result as {
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

      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const spawnTool = resolveTool(tools, "sessions_spawn");
      const result = await callTool(spawnTool, {
        task: "do routed work",
        agentId: target.id,
        runTimeoutSeconds: 3
      });
      const details = result as {
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
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const spawnTool = resolveTool(tools, "sessions_spawn");
      const result = await callTool(spawnTool, {
        task: "should be blocked"
      });
      const details = result as {
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
        parentThreadId: current.id,
        childThreadId: child.id,
        task: "list me",
        cleanup: "keep",
        status: "running"
      });

      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const listTool = resolveTool(tools, "subagents_list");
      const result = await callTool(listTool, {});
      const details = result as {
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
        parentThreadId: current.id,
        childThreadId: child.id,
        task: "kill me",
        cleanup: "keep",
        status: "running"
      });

      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const killTool = resolveTool(tools, "subagents_kill");
      const result = await callTool(killTool, {
        runId
      });
      const details = result as {
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
        parentThreadId: current.id,
        childThreadId: child.id,
        task: "send me",
        cleanup: "keep",
        status: "running",
        channelId: "channel-current",
        modelId: "model-send"
      });

      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const sendTool = resolveTool(tools, "subagents_send");
      const result = await callTool(sendTool, {
        runId,
        message: "follow up",
        timeoutSeconds: 3
      });
      const details = result as {
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
        parentThreadId: current.id,
        childThreadId: child.id,
        task: "old task",
        cleanup: "keep",
        status: "running",
        channelId: "channel-current",
        modelId: "model-steer"
      });

      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const steerTool = resolveTool(tools, "subagents_steer");
      const result = await callTool(steerTool, {
        runId: oldRunId,
        message: "new direction",
        timeoutSeconds: 0
      });
      const details = result as {
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
        parentThreadId: current.id,
        childThreadId: child.id,
        task: "already running",
        cleanup: "keep",
        status: "running"
      });

      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const spawnTool = resolveTool(tools, "sessions_spawn");
      const result = await callTool(spawnTool, {
        task: "another child"
      });
      const details = result as { status?: string; error?: string };
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
        parentThreadId: root.id,
        rootThreadId: root.id,
        depth: 1,
        childThreadId: current.id,
        task: "depth parent",
        cleanup: "keep",
        status: "running"
      });

      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const spawnTool = resolveTool(tools, "sessions_spawn");
      const result = await callTool(spawnTool, {
        task: "too deep"
      });
      const details = result as { status?: string; error?: string };
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
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: parent.id
      });
      const spawnTool = resolveTool(tools, "sessions_spawn");
      const result = await callTool(spawnTool, {
        task: "async task",
        runTimeoutSeconds: 0,
        model: "model-delivery",
        deliverySessionKey: inbox.id,
        thread: true
      });
      const details = result as {
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
      expect(run?.deliveryThreadId).toBe(inbox.id);

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
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: "agent:main:subagent:test"
      });
      const spawnTool = resolveTool(tools, "sessions_spawn");
      const result = await callTool(spawnTool, { task: "do work" });
      const details = result as { status?: string; error?: string };
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
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: "agent:main:subagent:test"
      });
      const sendTool = resolveTool(tools, "sessions_send");
      const sendResult = await callTool(sendTool, {
        sessionKey: "main",
        message: "hello"
      });
      const sendDetails = sendResult as { status?: string; error?: string };
      expect(sendDetails.status).toBe("error");
      expect(sendDetails.error).toContain("sessions_send is not allowed from sub-agent sessions");

      const agentsListTool = resolveTool(tools, "agents_list");
      const listResult = await callTool(agentsListTool, {});
      const listDetails = listResult as { status?: string; error?: string };
      expect(listDetails.status).toBe("error");
      expect(listDetails.error).toContain("agents_list is not allowed from sub-agent sessions");

      const deleteTool = resolveTool(tools, "sessions_delete");
      const deleteResult = await callTool(deleteTool, {
        sessionKey: "main"
      });
      const deleteDetails = deleteResult as { status?: string; error?: string };
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
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const historyTool = resolveTool(tools, "sessions_history");
      const result = await callTool(historyTool, {});
      const details = result as { status?: string; error?: string };
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

      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const historyTool = resolveTool(tools, "sessions_history");
      const result = await callTool(historyTool, {
        label: "目标会话",
        limit: 10
      });
      const details = result as {
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

      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const deleteTool = resolveTool(tools, "sessions_delete");
      const result = await callTool(deleteTool, {
        label: "目标会话"
      });
      const details = result as {
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
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const deleteTool = resolveTool(tools, "sessions_delete");
      const result = await callTool(deleteTool, {
        sessionKey: current.id
      });
      const details = result as {
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
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const deleteTool = resolveTool(tools, "sessions_delete");
      const result = await callTool(deleteTool, {
        sessionKeys: [targetA.id, targetB.id]
      });
      const details = result as {
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
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const deleteTool = resolveTool(tools, "sessions_delete");
      const result = await callTool(deleteTool, {
        label: "同名会话"
      });
      const details = result as {
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
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({
        threadId: current.id
      });
      const deleteTool = resolveTool(tools, "sessions_delete");
      const result = await callTool(deleteTool, {
        sessionKeys: [target.id, current.id]
      });
      const details = result as {
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

  test("WebSearch 应直接暴露 SDK 原生搜索结果", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    globalThis.fetch = mock(async () =>
      new Response(
        `
          <a rel="nofollow" class="result__a" href="https://example.com/path?a=1">Example Title</a>
          <a class="result__snippet">This is a description</a>
        `,
        { status: 200, headers: { "content-type": "text/html" } }
      )
    ) as unknown as typeof fetch;

    try {
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({ threadId: "agent:main:test" });
      const webSearchTool = resolveTool(tools, "WebSearch");
      const result = await callTool(webSearchTool, {
        query: "example"
      });
      const details = result as {
        query?: string;
        results?: Array<{ title?: string; url?: string; snippet?: string }>;
      };
      expect(details.query).toBe("example");
      expect(details.results?.length).toBe(1);
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

  test("WebSearch 应忽略旧兼容层 provider 参数并继续使用原生搜索", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    globalThis.fetch = mock(async () =>
      new Response(
        `
          <a rel="nofollow" class="result__a" href="https://example.com/provider-ignored">Provider Ignored</a>
          <a class="result__snippet">Provider should be ignored</a>
        `,
        { status: 200, headers: { "content-type": "text/html" } }
      )
    ) as unknown as typeof fetch;
    try {
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({ threadId: "agent:main:test" });
      const webSearchTool = resolveTool(tools, "WebSearch");
      const result = await callTool(webSearchTool, {
        query: "example",
        provider: "brave"
      });
      const details = result as { query?: string; results?: unknown[] };
      expect(details.query).toBe("example");
      expect(Array.isArray(details.results)).toBeTrue();
      expect((details.results as Array<{ title?: string }>)[0]?.title).toBe("Provider Ignored");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });

  test("WebSearch SDK 错误应透传原生错误文本", async () => {
    const previousConfigDir = process.env.LUME_CONFIG_DIR;
    const originalFetch = globalThis.fetch;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-openclaw-tools-"));
    globalThis.fetch = mock(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;
    try {
      const createSdkSessionTools = await loadCreateSdkSessionTools();
      const tools = createSdkSessionTools({ threadId: "agent:main:test" });
      const webSearchTool = resolveTool(tools, "WebSearch");
      const result = await callTool(webSearchTool, {
        query: "timeout case"
      });
      expect(result).toEqual("Search error: The operation was aborted.");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = previousConfigDir;
      }
    }
  });
});








