import { registerRealAgentStores } from "../agent-thread-store-test-adapter";
registerRealAgentStores();
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SdkEventEnvelope } from "@lume/shared";
import type { AgentRuntimeRunParams, AgentRuntimeEmitter } from "./types";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import { getThreadEventBus } from "../events/thread-event-bus";
import { LumeRunner } from "./lume-runner";
import { getMemoryConfigPath } from "../../infra/config-paths";

function createTestParams(threadId: string): AgentRuntimeRunParams {
  return {
    input: {
      threadId,
      userMessage: "hello",
      permissionMode: "default",
      chatType: "direct"
    },
    runtime: {
      sessionId: threadId,
      channelId: "channel-1",
      resolvedModelId: "model-1",
      threadType: "main"
    }
  };
}

function createPrepared(agentDir: string) {
  return {
    agentCwd: agentDir,
    agentDir,
    modelResolution: {
      provider: "openai",
      resolvedModelId: "model-1",
      model: {
        id: "model-1",
        provider: "openai"
      }
    },
    openaiApiMode: "responses",
    apiKey: "test-key"
  } as Parameters<typeof LumeRunner.create>[0]["prepared"];
}

function createRuntimeEventCollector(): {
  emitter: AgentRuntimeEmitter;
  runtimeEvents: Array<Record<string, unknown>>;
} {
  const runtimeEvents: Array<Record<string, unknown>> = [];
  return {
    runtimeEvents,
    emitter: {
      onSdkMessage: () => {},
      onComplete: () => {},
      onError: () => {},
      onAskUserQuestion: () => {},
      onBrowserAuthRequest: () => {},
      onToolPermissionRequest: () => {},
      onRuntimeEvent: (event) => runtimeEvents.push(event as unknown as Record<string, unknown>)
    }
  };
}

async function* assistantStream(): AsyncIterable<SDKMessage> {
  yield {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }]
    }
  } as SDKMessage;
}

const memoryItems = [{
  id: "mem-1",
  kind: "preference" as const,
  scope: "global" as const,
  status: "active" as const,
  statement: "User prefers concise answers",
  path: "memory/global/memory.md#L1",
  citation: "memory/global/memory.md#L1",
  reason: "semantic match",
  score: 0.9,
  claim: {
    subject: "User",
    predicate: "prefers",
    object: "concise answers",
    applies_when: {},
    valid_from: null,
    valid_to: null
  }
}];

interface MemoryBusRunResult {
  runner: LumeRunner;
  runtimeEvents: Array<Record<string, unknown>>;
}

async function runMemorySession(input: { threadId: string; agentDir: string }): Promise<MemoryBusRunResult> {
  const { emitter, runtimeEvents } = createRuntimeEventCollector();
  const runner = await LumeRunner.create({
    params: createTestParams(input.threadId),
    prepared: createPrepared(input.agentDir),
    emit: emitter
  });
  await runner.runRuntimeSession({
    params: createTestParams(input.threadId),
    prepared: createPrepared(input.agentDir),
    runtimeSession: {
      agent: {
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        interrupt: async () => {},
        query: () => assistantStream()
      },
      session: {
        sessionId: "sdk-session-1",
        threadId: "sdk-thread-1",
        dispose: async () => {}
      },
      tools: [],
      userMessageForModel: "hello",
      memoryContextUsedItems: memoryItems
    } as any,
    options: {
      registerAbort: () => {},
      unregisterAbort: () => {}
    },
    createCanUseTool: () => async () => ({ behavior: "allow" })
  });
  return { runner, runtimeEvents };
}

function isMemoryContextUsedDetail(detail: unknown): boolean {
  return (detail as { type?: string } | null)?.type === "memory.context.used";
}

describe("LumeRunner memory.context.used 第二注入路径", () => {
  const dirs: string[] = [];

  afterEach(() => {
    delete process.env.LUME_CONFIG_DIR;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bus publish 单源(T7a 后旧路 emit 已删),detail.items 为同一数组", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-bus-on-"));
    const configDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-bus-on-config-"));
    dirs.push(agentDir, configDir);
    process.env.LUME_CONFIG_DIR = configDir;

    const threadId = "memory-bus-on";
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      if (isMemoryContextUsedDetail(envelope.detail)) published.push(envelope);
    });

    const { runner, runtimeEvents } = await runMemorySession({ threadId, agentDir });

    // T7a:旧路 emit 已删,memory.context.used 不再经 RUNTIME_EVENT 产生
    const legacy = runtimeEvents.find((event) => event.type === "memory.context.used") as
      | { runId: string; items: unknown[] }
      | undefined;
    expect(legacy).toBeUndefined();

    // 新路:总线收到骨架事件(run 级领域事件)
    expect(published).toHaveLength(1);
    const envelope = published[0]!;
    expect(envelope.kind).toBe("run");
    expect(envelope.phase).toBe("event");
    expect(envelope.turnId).toBeNull();
    expect(envelope.threadId).toBe(threadId);
    expect(envelope.runId).toBe(runner.getRunId());
    expect(envelope.seq).toBeNumber();

    // detail.items 为原始引用(sidecar 透传,非复制)
    const detail = envelope.detail as { type: string; items: unknown[] };
    expect(detail.type).toBe("memory.context.used");
    expect(detail.items).toEqual([expect.objectContaining({
      id: "mem-1",
      kind: "preference",
      scope: "global",
      status: "active",
      citation: "memory/global/memory.md#L1",
      reason: "semantic match",
      claim: expect.objectContaining({ subject: "User", predicate: "prefers" })
    })]);

    // 持久化:events.jsonl 落盘
    expect(await getThreadEventBus(sessionDir).read(threadId))
      .toContainEqual(expect.objectContaining({
        kind: "run",
        phase: "event",
        detail: expect.objectContaining({ type: "memory.context.used" })
      }));
  });

  test("citations 配置关:早退于 publish 之前,双路皆不发", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-bus-cite-off-"));
    const configDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-bus-cite-off-config-"));
    dirs.push(agentDir, configDir);
    process.env.LUME_CONFIG_DIR = configDir;
    writeFileSync(getMemoryConfigPath(), JSON.stringify({ citations: "off" }), "utf-8");

    const threadId = "memory-bus-cite-off";
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      if (isMemoryContextUsedDetail(envelope.detail)) published.push(envelope);
    });

    const { runtimeEvents } = await runMemorySession({ threadId, agentDir });

    expect(runtimeEvents.find((event) => event.type === "memory.context.used")).toBeUndefined();
    expect(published).toHaveLength(0);
    expect((await getThreadEventBus(sessionDir).read(threadId))
      .filter((envelope) => isMemoryContextUsedDetail(envelope.detail))).toEqual([]);
  });
});
