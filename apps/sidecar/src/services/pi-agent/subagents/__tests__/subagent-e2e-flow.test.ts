import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  appendAgentMessage,
  createAgentSession,
  getAgentSessionMessages
} from "../../../agent-session-manager";
import {
  getSubagentRunRegistry,
  resetSubagentRunRegistryForTest
} from "../subagent-run-registry";

mock.module("undici", () => ({
  EnvHttpProxyAgent: class {},
  setGlobalDispatcher: () => undefined
}));

mock.module("../../run-pi-agent-message", () => ({
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

mock.module("../../runner/run", () => ({
  stopPiAgent: () => undefined
}));

let previousConfigDir: string | undefined;

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.LUME_CONFIG_DIR;
  } else {
    process.env.LUME_CONFIG_DIR = previousConfigDir;
  }
  resetSubagentRunRegistryForTest();
});

async function loadCreateOpenClawAlignedTools() {
  const mod = await import("../../tools/create-openclaw-aligned-tools");
  return mod.createOpenClawAlignedTools;
}

function resolveTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  return tool;
}

async function waitForRunsSettled(runIds: string[], timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runs = runIds.map((runId) => getSubagentRunRegistry().get(runId));
    const settled = runs.every((run) => (
      !!run
      && (run.status === "completed" || run.status === "errored" || run.status === "aborted" || run.status === "timed_out" || run.status === "canceled")
      && run.announceStatus !== "pending"
    ));
    if (settled) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runs not settled in ${timeoutMs}ms: ${runIds.join(",")}`);
}

describe("subagent-e2e-flow", () => {
  test("应覆盖并发 spawn + 故障恢复链路", async () => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-subagent-e2e-"));
    resetSubagentRunRegistryForTest();

    const parent = createAgentSession("父会话", "channel-current");
    appendAgentMessage(parent.id, {
      id: randomUUID(),
      role: "assistant",
      content: "model hint",
      createdAt: Date.now(),
      model: "model-e2e"
    });
    const createOpenClawAlignedTools = await loadCreateOpenClawAlignedTools();
    const tools = createOpenClawAlignedTools({
      sessionId: parent.id
    });
    const spawnTool = resolveTool(tools as unknown as AgentTool[], "sessions_spawn");

    const [okResult, errResult] = await Promise.all([
      spawnTool.execute("tool-call-e2e-ok", {
        task: "[mock-slow] 并发任务-成功",
        runTimeoutSeconds: 0
      }),
      spawnTool.execute("tool-call-e2e-err", {
        task: "[mock-slow][mock-error] 并发任务-失败",
        runTimeoutSeconds: 0
      })
    ]);

    const okRunId = (okResult.details as { runId?: string }).runId;
    const errRunId = (errResult.details as { runId?: string }).runId;
    expect(typeof okRunId).toBe("string");
    expect(typeof errRunId).toBe("string");
    if (!okRunId || !errRunId) return;

    await waitForRunsSettled([okRunId, errRunId]);

    const okRun = getSubagentRunRegistry().get(okRunId);
    const errRun = getSubagentRunRegistry().get(errRunId);
    expect(okRun?.status).toBe("completed");
    expect(okRun?.announceStatus).toBe("delivered");
    expect(errRun?.status).toBe("errored");
    expect(errRun?.outcome?.errorCode).toBe("SUBAGENT_RUNTIME_ERROR");
    expect(errRun?.announceStatus).toBe("delivered");

    const parentMessages = getAgentSessionMessages(parent.id);
    const announceRunIds = new Set(
      parentMessages
        .filter((item) => item.metadata?.subagentAnnounce === true)
        .map((item) => typeof item.metadata?.runId === "string" ? item.metadata.runId : "")
        .filter(Boolean)
    );
    expect(announceRunIds.has(okRunId)).toBe(true);
    expect(announceRunIds.has(errRunId)).toBe(true);

    resetSubagentRunRegistryForTest();
    const restoredErrRun = getSubagentRunRegistry().get(errRunId);
    expect(restoredErrRun?.status).toBe("errored");
    expect(restoredErrRun?.outcome?.errorCode).toBe("SUBAGENT_RUNTIME_ERROR");
  });
});
