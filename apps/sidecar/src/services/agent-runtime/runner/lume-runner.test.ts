import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@lume/shared";
import type { AgentRuntimeRunParams, AgentRuntimeEmitter } from "../runtime-core/types";
import type { LumeWorkflowHookEvent } from "../../workflow-hooks/hook-events";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import { getThreadEventBus } from "../events/thread-event-bus";
import { LumeRunner, resolveRuntimeCoreMaxTurns } from "./lume-runner";
import type { LumeRunState } from "../runtime-core/run-state";
import { createMemoryV2Store } from "../../memory-v2/markdown-store";
import { getMemoryV2ScopePaths } from "../../memory-v2/paths";
import { setActiveBrowserBroker } from "../../browser/browser-broker-holder";
import { getBrowserToolSessionRegistry } from "../tools/browser/browser-tool-session";

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

function createPrepared(agentDir: string, catalogMaxTokens?: number) {
  return {
    agentCwd: agentDir,
    agentDir,
    modelResolution: {
      provider: "openai",
      resolvedModelId: "model-1",
      model: {
        id: "model-1",
        provider: "openai",
        maxTokens: 32768
      },
      ...(catalogMaxTokens === undefined ? {} : { catalogMaxTokens })
    },
    openaiApiMode: "responses",
    apiKey: "test-key"
  } as Parameters<typeof LumeRunner.create>[0]["prepared"];
}

function createEmitter(events: string[]): AgentRuntimeEmitter {
  return {
    onSdkMessage: (message) => events.push(`sdk:${message.type}`),
    onComplete: () => events.push("complete"),
    onError: (message) => events.push(`error:${message}`),
    onAskUserQuestion: () => {},
    onBrowserAuthRequest: () => {},
    onToolPermissionRequest: () => {}
  };
}

function createRuntimeEventEmitter(events: string[]): AgentRuntimeEmitter {
  return {
    ...createEmitter(events),
    onRuntimeEvent: (event) => events.push(`runtime:${event.type}`)
  };
}

async function* stream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const message of messages) {
    yield message;
  }
}

async function createRunner(agentDir: string, events: string[] = []) {
  const params = createTestParams("thread-1");
  return LumeRunner.create({
    params,
    prepared: createPrepared(agentDir),
    emit: createEmitter(events)
  });
}

function readOnlyRunState(agentDir: string): LumeRunState {
  const sessionDir = getRuntimeCoreSessionDir("thread-1", agentDir);
  const runFile = readdirSync(join(sessionDir, "runs"))
    .find((file) => file.endsWith(".json") && !file.endsWith(".items.jsonl"));
  if (!runFile) {
    throw new Error("run state not found");
  }
  return JSON.parse(readFileSync(join(sessionDir, "runs", runFile), "utf8")) as LumeRunState;
}

function readRunItems(agentDir: string): unknown[] {
  const sessionDir = getRuntimeCoreSessionDir("thread-1", agentDir);
  const itemsFile = readdirSync(join(sessionDir, "runs"))
    .find((file) => file.endsWith(".items.jsonl"));
  if (!itemsFile) {
    return [];
  }
  return readFileSync(join(sessionDir, "runs", itemsFile), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readTrace(agentDir: string): {
  spans: Array<{
    type: string;
    name: string;
    status: string;
    output?: unknown;
    metadata?: Record<string, unknown>;
  }>;
} {
  const sessionDir = getRuntimeCoreSessionDir("thread-1", agentDir);
  const tracesDir = join(sessionDir, "traces");
  const traceFile = readdirSync(tracesDir)
    .find((file) => file.endsWith(".json"));
  if (!traceFile) {
    throw new Error("trace not found");
  }
  const trace = JSON.parse(readFileSync(join(tracesDir, traceFile), "utf8"));
  const traceId = traceFile.slice(0, -".json".length);
  const spansPath = join(tracesDir, `${traceId}.spans.jsonl`);
  if (existsSync(spansPath)) {
    const records = readFileSync(spansPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const byId = new Map<string, { id: string }>();
    for (const span of records) {
      byId.set(span.id, span);
    }
    trace.spans = [...byId.values()];
  } else {
    trace.spans = [];
  }
  return trace;
}

describe("LumeRunner", () => {
  const dirs: string[] = [];

  afterEach(() => {
    setActiveBrowserBroker(null);
    getBrowserToolSessionRegistry().take("thread-1");
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses 80 turn budget for direct, planning, and task execution", () => {
    expect(resolveRuntimeCoreMaxTurns({
      threadId: "thread-1",
      userMessage: "plan",
      permissionMode: "plan"
    })).toBe(80);
    expect(resolveRuntimeCoreMaxTurns({
      threadId: "thread-1",
      userMessage: "task",
      permissionMode: "acceptEdits",
      messageMetadata: {
        taskRunId: "taskrun-1",
        taskControlEvent: "execute_task"
      }
    })).toBe(80);
    expect(resolveRuntimeCoreMaxTurns({
      threadId: "thread-1",
      userMessage: "hello",
      permissionMode: "default"
    })).toBe(80);
  });

  test("allows a hidden background agent to request a smaller bounded turn budget", () => {
    expect(resolveRuntimeCoreMaxTurns({
      threadId: "thread-1",
      userMessage: "background memory extraction",
      messageMetadata: { hiddenFromChat: true, maxTurns: 5 }
    })).toBe(5);
    expect(resolveRuntimeCoreMaxTurns({
      threadId: "thread-1",
      userMessage: "background memory organization",
      messageMetadata: { hiddenFromChat: true, maxTurns: 200 }
    })).toBe(80);
  });

  test("complete emits completion and finalizes run state", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-complete-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await createRunner(agentDir, events);

    const result = await runner.complete();

    expect(result).toEqual({ status: "completed" });
    expect(events).toEqual(["complete"]);
    expect(readOnlyRunState(agentDir).status).toBe("completed");
  });

  test("complete captures explicit memory intent without blocking completion", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-"));
    const configDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-config-"));
    dirs.push(agentDir, configDir);
    process.env.LUME_CONFIG_DIR = configDir;
    try {
      const params = createTestParams("thread-1");
      params.input.userMessage = "以后默认用中文回答";
      const runner = await LumeRunner.create({
        params,
        prepared: {
          ...createPrepared(agentDir),
          workspaceSlug: "demo"
        },
        emit: createEmitter([])
      });

      const result = await runner.complete();
      expect(result).toEqual({ status: "completed" });
      expect(createMemoryV2Store().listEntries({
        workspaceSlug: "demo",
        scopes: ["global"],
        includeStatuses: ["active"]
      })).toEqual([]);
      await Bun.sleep(80);
      const entries = createMemoryV2Store().listEntries({
        workspaceSlug: "demo",
        scopes: ["global"],
        includeStatuses: ["active"]
      });
      expect(entries).toEqual([expect.objectContaining({
        statement: "默认用中文回答"
      })]);
    } finally {
      delete process.env.LUME_CONFIG_DIR;
    }
  });

  test("complete writes compact daily and run memory history", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-history-"));
    const configDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-history-config-"));
    dirs.push(agentDir, configDir);
    process.env.LUME_CONFIG_DIR = configDir;
    try {
      const params = createTestParams("thread-1");
      params.input.userMessage = `帮我分析记忆召回问题 ${"很长的上下文".repeat(80)} TAIL_SHOULD_BE_CROPPED`;
      const runner = await LumeRunner.create({
        params,
        prepared: {
          ...createPrepared(agentDir),
          workspaceSlug: "demo"
        },
        emit: createEmitter([])
      });

      await runner.runQueryStream(stream([{
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已经定位到记忆召回的问题，下一步会默认启用 ONNX 语义搜索。" }]
        }
      } as SDKMessage]));
      await runner.complete();

      const paths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" });
      const daily = readdirSync(paths.dailyDir).map((file) => readFileSync(join(paths.dailyDir, file), "utf-8")).join("\n");
      const runs = readdirSync(paths.runsDir!).map((file) => readFileSync(join(paths.runsDir!, file), "utf-8")).join("\n");
      expect(daily).toContain("User asked:");
      expect(daily).toContain("Assistant outcome:");
      expect(daily).toContain("记忆召回");
      expect(runs).toContain("User asked:");
      expect(runs).toContain("Assistant outcome:");
      expect(daily).not.toContain("TAIL_SHOULD_BE_CROPPED");
      expect(runs).not.toContain("TAIL_SHOULD_BE_CROPPED");
    } finally {
      delete process.env.LUME_CONFIG_DIR;
    }
  });

  test("complete schedules small-model conversation summary in background", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-summary-"));
    const configDir = mkdtempSync(join(tmpdir(), "lume-runner-memory-summary-config-"));
    dirs.push(agentDir, configDir);
    process.env.LUME_CONFIG_DIR = configDir;
    try {
      const params = createTestParams("thread-1");
      params.input.userMessage = "继续优化记忆跨对话连续性";
      let started = false;
      let resolveSummary: (summary: string) => void = () => {};
      const summaryPromise = new Promise<string>((resolve) => {
        resolveSummary = resolve;
      });
      const runner = await LumeRunner.create({
        params,
        prepared: {
          ...createPrepared(agentDir),
          workspaceSlug: "demo"
        },
        emit: createEmitter([]),
        summarizeMemoryConversation: async () => {
          started = true;
          return summaryPromise;
        }
      });

      await runner.runQueryStream(stream([{
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我会把最近做过的事整理成更容易召回的摘要。" }]
        }
      } as SDKMessage]));
      const result = await runner.complete();

      expect(result).toEqual({ status: "completed" });
      expect(started).toBe(true);
      const paths = getMemoryV2ScopePaths({ scope: "workspace", workspaceSlug: "demo" });
      let daily = readdirSync(paths.dailyDir).map((file) => readFileSync(join(paths.dailyDir, file), "utf-8")).join("\n");
      expect(daily).not.toContain("小模型总结");

      resolveSummary("小模型总结：正在修复 Lume 的记忆连续性；下一步默认使用 ONNX 语义召回。");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      daily = readdirSync(paths.dailyDir).map((file) => readFileSync(join(paths.dailyDir, file), "utf-8")).join("\n");
      expect(daily).toContain("小模型总结");
    } finally {
      delete process.env.LUME_CONFIG_DIR;
    }
  });

  test("complete waits for observed runtime events before terminal event", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-complete-order-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter(events)
    });

    await runner.runQueryStream(stream([{
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }]
      }
    } as SDKMessage]));
    await runner.complete();

    expect(events).toEqual([
      "sdk:assistant",
      "complete"
    ]);
  });

  test("complete no longer emits migrated legacy RuntimeEvents (T7a)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-runtime-events-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter(events)
    });

    await runner.runQueryStream(stream([{
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }]
      }
    } as SDKMessage]));
    await runner.complete();

    // T7a:assistant.delta/run.completed 已迁事件总线,旧路不再产
    expect(events).toEqual([
      "sdk:assistant",
      "complete"
    ]);
  });

  test("fires run lifecycle hooks in order and applies observe effects", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const seen: string[] = [];
    const addedCandidates: string[] = [];
    const runner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: {
        ...createPrepared(agentDir),
        workspaceSlug: "demo"
      },
      emit: createRuntimeEventEmitter(events),
      workflowHooks: {
        execute: async (event: LumeWorkflowHookEvent) => {
          seen.push(event.event);
          if (event.event !== "run.afterComplete") return { effects: [], errors: [] };
          return {
            effects: [{
              effect: {
                type: "emitRuntimeEvent",
                event: {
                  type: "workflow_hook.diagnostic",
                  runId: event.runId,
                  threadId: event.threadId,
                  contributionId: "test",
                  message: "complete",
                  level: "info"
                }
              },
              sourceContributionId: "test",
              createdAt: "2026-05-26T00:00:00.000Z"
            }, {
              effect: {
                type: "recordTrace",
                record: {
                  type: "workflow_hook",
                  contributionId: "trace",
                  event: "run.afterComplete",
                  status: "success",
                  effectTypes: ["emitRuntimeEvent", "recordTrace", "enqueueMemoryCandidate"]
                }
              },
              sourceContributionId: "trace",
              createdAt: "2026-05-26T00:00:00.000Z"
            }, {
              effect: {
                type: "enqueueMemoryCandidate",
                candidates: [{
                  kind: "preference",
                  targetScope: "global",
                  statement: "User prefers concise summaries.",
                  confidence: "medium",
                  evidence: { sourceMessages: ["I prefer concise summaries."] }
                }]
              },
              sourceContributionId: "memory",
              createdAt: "2026-05-26T00:00:00.000Z"
            }],
            errors: []
          };
        }
      } as any,
      addMemoryCandidate: async ({ candidate }) => {
        addedCandidates.push(candidate.statement);
        return { action: "new" } as any;
      }
    });

    await runner.complete();

    expect(seen).toEqual(["run.afterComplete"]);
    expect(events).toContain("runtime:workflow_hook.diagnostic");
    expect(addedCandidates).toEqual(["User prefers concise summaries."]);
    const trace = readTrace(agentDir);
    expect(trace.spans).toContainEqual(expect.objectContaining({
      type: "guardrail",
      name: "workflow hook: run.afterComplete",
      metadata: expect.objectContaining({
        sourceContributionId: "trace",
        contributionId: "trace",
        event: "run.afterComplete",
        status: "success"
      })
    }));
  });

  test("fail emits error and finalizes run state", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-fail-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await createRunner(agentDir, events);

    const result = await runner.fail("boom");

    expect(result).toEqual({ status: "errored", errorMessage: "boom" });
    expect(events).toEqual(["error:boom"]);
    const state = readOnlyRunState(agentDir);
    expect(state.status).toBe("failed");
    expect(state.error?.message).toBe("boom");
  });

  test("abort no longer emits legacy run.cancelled (T7a: migrated to bus)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-abort-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter(events)
    });

    const result = await runner.abort();

    expect(result).toEqual({ status: "aborted" });
    expect(events).toEqual(["complete"]);
  });

  test("soft-abort error result finalizes as cancelled when the abort signal fired", async () => {
    // F1 regression: the SDK no longer throws on abort — it ends the stream
    // with error_during_execution ("Run aborted by user."). With the abort
    // signal set that must land as cancelled, not failed.
    const abortedDir = mkdtempSync(join(tmpdir(), "lume-runner-soft-abort-"));
    dirs.push(abortedDir);
    const abortController = new AbortController();
    abortController.abort();
    const abortedParams = createTestParams("thread-1");
    abortedParams.runtime.abortSignal = abortController.signal;
    const abortedEvents: string[] = [];
    const abortedRunner = await LumeRunner.create({
      params: abortedParams,
      prepared: createPrepared(abortedDir),
      emit: createRuntimeEventEmitter(abortedEvents)
    });

    const abortedResult = await abortedRunner.runQueryStream(stream([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Run aborted by user."]
      } as SDKMessage
    ]));

    expect(abortedResult).toEqual({ status: "aborted" });
    // T7a:run.cancelled 已迁事件总线,旧路不再产;归一语义由 run state 断言承载
    expect(abortedEvents).not.toContain("runtime:run.cancelled");
    expect(readOnlyRunState(abortedDir).status).toBe("cancelled");

    // 对照：非 abort 的同类 error result 仍归 failed。
    const failedDir = mkdtempSync(join(tmpdir(), "lume-runner-hard-error-"));
    dirs.push(failedDir);
    const failedEvents: string[] = [];
    const failedRunner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: createPrepared(failedDir),
      emit: createRuntimeEventEmitter(failedEvents)
    });

    const failedResult = await failedRunner.runQueryStream(stream([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["model exploded"]
      } as SDKMessage
    ]));

    expect(failedResult).toEqual({ status: "errored", errorMessage: "model exploded" });
    expect(readOnlyRunState(failedDir).status).toBe("failed");
  });

  test("fail no longer fires workflow hooks and preserves original failure", async () => {
    // run.beforeStart / run.afterFailure 投机事件已删：失败路径不再触发任何 hook
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-fail-"));
    dirs.push(agentDir);
    const seen: string[] = [];
    const runner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter([]),
      workflowHooks: {
        execute: async (event: LumeWorkflowHookEvent) => {
          seen.push(event.event);
          return { effects: [], errors: [] };
        }
      } as any
    });

    const result = await runner.fail("model failed");

    expect(seen).toEqual([]);
    expect(result).toEqual({ status: "errored", errorMessage: "model failed" });
  });

  test("does not fire production lifecycle hooks when hooks are disabled", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-disabled-"));
    dirs.push(agentDir);
    const seen: string[] = [];
    const runner = await LumeRunner.create({
      params: createTestParams("thread-disabled"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter([]),
      createWorkflowHooks: () => ({
        execute: async (event: LumeWorkflowHookEvent) => {
          seen.push(event.event);
          return { effects: [], errors: [] };
        }
      } as any),
      hooksConfig: { enabled: false, memory: true, security: true, observability: true }
    });

    await runner.complete();

    expect(seen).toEqual([]);
  });

  test("passes the same production hook runtime to context and permission", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-production-"));
    dirs.push(agentDir);
    let contextWired = false;
    let canUseToolWired = false;
    const workflowHooks = {
      execute: async (_event: LumeWorkflowHookEvent) => ({ effects: [], errors: [] })
    } as any;
    const runner = await LumeRunner.create({
      params: createTestParams("thread-production"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter([]),
      createWorkflowHooks: () => workflowHooks,
      hooksConfig: { enabled: true, memory: true, security: true, observability: true }
    });

    await runner.runPreparedRuntimeCoreAttempt({
      params: createTestParams("thread-production"),
      prepared: createPrepared(agentDir),
      options: {
        registerAbort: () => {},
        unregisterAbort: () => {}
      },
      createRuntimeSession: async (input) => {
        expect(input.workflowHooks).toBe(workflowHooks);
        expect(input.applyWorkflowHookEffects).toEqual(expect.any(Function));
        contextWired = true;
        return {
          agent: {
            setModel: async () => {},
            setMaxThinkingTokens: async () => {},
            interrupt: async () => {},
            query: () => stream([])
          },
          session: {
            sessionId: "sdk-session-1",
            threadId: "sdk-thread-1",
            dispose: async () => {}
          },
          tools: [],
          userMessageForModel: "hello",
          memoryContextUsedItems: []
        } as any;
      },
      createCanUseTool: (_askUserSignal, workflowHooksInput) => {
        expect(workflowHooksInput).toBe(workflowHooks);
        canUseToolWired = true;
        return async () => ({ behavior: "allow" });
      }
    });

    // run.beforeStart 投机事件已删；接线验证改为直接断言两处回调确实执行
    expect(contextWired).toBe(true);
    expect(canUseToolWired).toBe(true);
  });

  test("runQueryStream finalizes non-completed stream results", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-stream-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await createRunner(agentDir, events);

    const result = await runner.runQueryStream(stream([{
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["stream failed"]
    } as SDKMessage]));

    expect(result).toEqual({ status: "errored", errorMessage: "stream failed" });
    expect(events).toEqual(["sdk:result"]);
    expect(readOnlyRunState(agentDir).status).toBe("failed");
  });

  test("runQueryStream treats max-turn results as continuable completion", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-max-turns-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter(events)
    });

    const result = await runner.runQueryStream(stream([{
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 20,
      contextUsage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 12,
        estimatedTailTokens: 0,
        contextWindow: 1000,
        contextWindowSource: "model",
        source: "provider"
      },
      billingUsage: {
        cumulative: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 12
        },
        latestRecord: {
          callerLabel: "Conversation",
          model: "model-1",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 12,
          costUSD: 0,
          usageIdentity: {
            threadId: "thread-1",
            callerKind: "conversation"
          }
        },
        records: [{
          callerLabel: "Conversation",
          model: "model-1",
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 12,
          costUSD: 0,
          usageIdentity: {
            threadId: "thread-1",
            callerKind: "conversation"
          }
        }],
        totalCostUSD: 0
      }
    } as SDKMessage]));

    expect(result).toEqual({
      status: "turn_limited",
      errorMessage: "Agent SDK 达到最大回合数（20），本轮需要继续执行。"
    });
    // T7a:run.turn_limited 已迁事件总线,旧路不再产;usage.updated(裁定保留)照旧
    expect(events).toEqual(["sdk:result", "runtime:usage.updated"]);
    expect(readOnlyRunState(agentDir).status).toBe("completed");
    expect(readRunItems(agentDir)).toContainEqual(expect.objectContaining({
      type: "system_event",
      name: "turn_limited"
    }));
  });

  test("records tool call spans from SDK stream messages", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-tool-span-"));
    dirs.push(agentDir);
    const runner = await createRunner(agentDir);

    const result = await runner.runQueryStream(stream([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } }
          ]
        }
      } as SDKMessage,
      {
        type: "tool_result",
        result: {
          tool_use_id: "tool-1",
          tool_name: "Bash",
          output: "/tmp/project"
        }
      } as SDKMessage
    ]));
    await runner.complete();

    expect(result).toEqual({ status: "completed" });
    const toolSpan = readTrace(agentDir).spans.find((span) => span.type === "tool_call");
    expect(toolSpan).toMatchObject({
      type: "tool_call",
      name: "Bash",
      status: "completed",
      output: {
        toolName: "Bash",
        isError: false
      }
    });
  });

  test("records compaction spans from SDK compact boundary messages", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-compaction-span-"));
    dirs.push(agentDir);
    const runner = await createRunner(agentDir);

    await runner.runQueryStream(stream([
      {
        type: "system",
        subtype: "context_compaction_started",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 900,
          policy: "kernel-v1",
          source: "agent-runtime-kernel"
        }
      } as SDKMessage,
      {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 900,
          post_tokens: 300,
          summary: "manual summary",
          policy: "kernel-v1",
          source: "agent-runtime-kernel"
        }
      } as SDKMessage,
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "compacted" }]
        }
      } as SDKMessage
    ]));
    await runner.complete();

    const compactionSpan = readTrace(agentDir).spans.find((span) => span.type === "compaction");
    expect(compactionSpan).toMatchObject({
      type: "compaction",
      name: "context compaction",
      status: "completed",
      output: {
        trigger: "manual",
        preTokens: 900,
        postTokens: 300,
        summary: "manual summary",
        policy: "kernel-v1",
        source: "agent-runtime-kernel"
      }
    });
  });

  test("records subagent lifecycle events as parent run items and spans", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-subagent-span-"));
    dirs.push(agentDir);
    const runner = await createRunner(agentDir);

    await runner.runQueryStream(stream([
      {
        type: "system",
        subtype: "task_started",
        task_id: "task-1",
        tool_use_id: "agent-tool-1",
        description: "Inspect the runtime",
        prompt: "Find runtime files",
        session_id: "thread-1",
        subagent_run_id: "subagent-run-1"
      } as SDKMessage,
      {
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        summary: "Inspect the runtime",
        session_id: "thread-1",
        subagent_run_id: "subagent-run-1"
      } as SDKMessage
    ]));
    await runner.complete();

    const subagentItem = readRunItems(agentDir).find((item) => (
      typeof item === "object" && item !== null && (item as { type?: string }).type === "subagent"
    ));
    expect(subagentItem).toMatchObject({
      type: "subagent",
      runId: "subagent-run-1",
      parentRunId: readOnlyRunState(agentDir).runId,
      parentToolCallId: "agent-tool-1",
      task: "Inspect the runtime",
      status: "completed",
      childThreadId: "subagent-run-1"
    });

    const subagentSpan = readTrace(agentDir).spans.find((span) => span.type === "subagent");
    expect(subagentSpan).toMatchObject({
      type: "subagent",
      name: "Inspect the runtime",
      status: "completed"
    });
  });

  test("redacts secret-like values from tool trace payloads", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-tool-redaction-"));
    dirs.push(agentDir);
    const runner = await createRunner(agentDir);

    await runner.runQueryStream(stream([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "tool-1",
            name: "memory.remember",
            input: {
              content: "OPENAI_API_KEY=sk-test-secret",
              nested: { token: "secret-token" }
            }
          }]
        }
      } as SDKMessage,
      {
        type: "tool_result",
        result: {
          tool_use_id: "tool-1",
          tool_name: "memory.remember",
          output: "saved sk-test-secret"
        }
      } as SDKMessage
    ]));
    await runner.complete();

    const traceJson = JSON.stringify(readTrace(agentDir));
    expect(traceJson).toContain("[REDACTED]");
    expect(traceJson).not.toContain("sk-test-secret");
    expect(traceJson).not.toContain("secret-token");
  });

  test("runRuntimeSession disposes the SDK session and finalizes its browser tabs", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-session-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await createRunner(agentDir, events);
    const lifecycle: string[] = [];
    let registeredAbort: (() => Promise<void>) | undefined;
    let queryOptions: { sandbox?: unknown; maxTokens?: number } | undefined;
    getBrowserToolSessionRegistry().getOrCreate("thread-1");
    setActiveBrowserBroker({
      dispatch: async (request: { method: string; browserSessionId?: string }) => {
        lifecycle.push(`browser:${request.method}:${request.browserSessionId}`);
        return {};
      }
    } as any);

    const result = await runner.runRuntimeSession({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      runtimeSession: {
        agent: {
          setModel: async (modelId: string) => {
            lifecycle.push(`setModel:${modelId}`);
          },
          setMaxThinkingTokens: async (tokens: number | null) => {
            lifecycle.push(`thinking:${tokens}`);
          },
          interrupt: async () => {
            lifecycle.push("interrupt");
          },
          query: (_message: unknown, options: { sandbox?: unknown; maxTokens?: number }) => {
            queryOptions = options;
            return stream([{
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "hello" }]
              }
            } as SDKMessage]);
          }
        },
        session: {
          sessionId: "sdk-session-1",
          threadId: "sdk-thread-1",
          dispose: async () => {
            lifecycle.push("dispose");
          }
        },
        tools: []
      } as any,
      options: {
        registerAbort: (_threadId, abort) => {
          registeredAbort = abort;
          lifecycle.push("registerAbort");
        },
        unregisterAbort: () => lifecycle.push("unregisterAbort")
      },
      createCanUseTool: () => async () => ({ behavior: "allow" })
    });

    await registeredAbort?.();

    expect(result).toEqual({ status: "completed" });
    expect(queryOptions?.sandbox).toBeUndefined();
    // #561+#631 review:model.maxTokens 是 createFallbackModel 的 32768 兜底猜测,
    // 无目录真值时不得抬进 query(自建网关 max_tokens 翻倍会 400 且不切 fallback),
    // 保持 SDK 16384 默认
    expect(queryOptions?.maxTokens).toBeUndefined();
    expect(events).toEqual(["sdk:assistant", "complete"]);
    expect(lifecycle).toEqual([
      "registerAbort",
      "setModel:model-1",
      "thinking:4096",
      "dispose",
      "browser:finalize_tabs:browser-tools:thread-1",
      "unregisterAbort",
      "interrupt"
    ]);
    expect(readOnlyRunState(agentDir).status).toBe("completed");
  });

  test("runRuntimeSession carries catalog-provided maxTokens into query overrides", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-catalog-max-tokens-"));
    dirs.push(agentDir);
    let queryOptions: { sandbox?: unknown; maxTokens?: number } | undefined;
    const runner = await createRunner(agentDir);
    const prepared = createPrepared(agentDir, 128_000);

    await runner.runRuntimeSession({
      params: createTestParams("thread-1"),
      prepared,
      runtimeSession: {
        agent: {
          setModel: async () => {},
          setMaxThinkingTokens: async () => {},
          interrupt: async () => {},
          query: (_message: unknown, options: { sandbox?: unknown; maxTokens?: number }) => {
            queryOptions = options;
            return stream([{
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "hello" }]
              }
            } as SDKMessage]);
          }
        },
        session: {
          sessionId: "sdk-session-1",
          threadId: "sdk-thread-1",
          dispose: async () => {}
        },
        tools: []
      } as any,
      options: {
        registerAbort: () => {},
        unregisterAbort: () => {}
      },
      createCanUseTool: () => async () => ({ behavior: "allow" })
    });

    // #561:渠道配置/目录真值经 catalogMaxTokens 抬升 query 输出上限
    expect(queryOptions?.maxTokens).toBe(128_000);
  });

  test("runPreparedRuntimeCoreAttempt creates runtime session with observed emitters", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-prepared-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await createRunner(agentDir, events);

    const result = await runner.runPreparedRuntimeCoreAttempt({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      options: {
        registerAbort: () => {},
        unregisterAbort: () => {}
      },
      createCanUseTool: () => async () => ({ behavior: "allow" }),
      createRuntimeSession: async (input) => {
        expect(input.trace?.traceId).toBeString();
        expect(input.openaiApiMode).toBe("responses");
        expect(input.persistCodingReport).toBeFunction();
        input.persistCodingReport?.({
          status: "verified",
          workspaceChanged: true,
          changedFiles: ["src/background.ts"],
          externalChangedFiles: [],
          pendingBackground: false,
        });
        input.emitSdkMessage?.({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "from session" }]
          }
        } as SDKMessage);
        return {
          agent: {
            setModel: async () => {},
            setMaxThinkingTokens: async () => {},
            interrupt: async () => {},
            query: () => stream([{
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "hello" }]
              }
            } as SDKMessage])
          },
          session: {
            sessionId: "sdk-session-1",
            threadId: "sdk-thread-1",
            dispose: async () => {}
          },
          tools: []
        } as any;
      }
    });

    expect(result).toEqual({ status: "completed" });
    expect(events).toEqual(["sdk:assistant", "sdk:assistant", "complete"]);
    expect(readRunItems(agentDir)).toHaveLength(2);
    expect(readOnlyRunState(agentDir).codingReport).toMatchObject({
      status: "verified",
      pendingBackground: false,
      changedFiles: ["src/background.ts"],
    });
  });

  // ─── F3:run 链内失败补总线终值 ───

  /** 读总线中指定 run 的 run.end 终值信封 */
  async function readBusRunEnds(agentDir: string, threadId: string) {
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const envelopes = await getThreadEventBus(sessionDir).read(threadId);
    return envelopes.filter((envelope) => envelope.kind === "run" && envelope.phase === "end");
  }

  test("createRuntimeSession 抛错:总线补发 run.end 错误终值,不再静默失败(F3)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-f3-session-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await createRunner(agentDir, events);

    const result = await runner.runPreparedRuntimeCoreAttempt({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      options: { registerAbort: () => {}, unregisterAbort: () => {} },
      createCanUseTool: () => async () => ({ behavior: "allow" }),
      createRuntimeSession: async () => {
        throw new Error("session boom");
      }
    });

    // 查询流从未启动 → projector 未开 run → 旧链路无任何总线终值
    expect(result).toEqual({ status: "errored", errorMessage: "session boom" });
    const runEnds = await readBusRunEnds(agentDir, "thread-1");
    expect(runEnds).toHaveLength(1);
    // fromActiveRun 抑制旧路合成 run.failed 后,这是 web 端终值的唯一来源
    expect(runEnds[0]!.runId).toBe(runner.getRunId());
    expect(runEnds[0]!.detail).toMatchObject({
      type: "run.end",
      stopReason: "error",
      isError: true,
      result: "session boom"
    });
  });

  test("投影链已交付终值后 fail() 不再补发,同一 run 只一个总线终值(F3 互斥)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-f3-mutex-"));
    dirs.push(agentDir);
    const runner = await createRunner(agentDir, []);

    // run 中途抛错:tee finally 先排空投影(projector 补发 error 终值),异常才向主流传播
    async function* failingStream(): AsyncIterable<SDKMessage> {
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "partial" }] }
      } as SDKMessage;
      throw new Error("mid-run boom");
    }
    await expect(runner.runQueryStream(failingStream())).rejects.toThrow("mid-run boom");

    // runRuntimeSession 的 catch 会走 fail():不应产生第二个 run.end
    await runner.fail("later failure");

    const runEnds = await readBusRunEnds(agentDir, "thread-1");
    expect(runEnds).toHaveLength(1);
    expect((runEnds[0]!.detail as { stopReason: string }).stopReason).toBe("error");
  });

  // #550:终值 append 自身同步 throw(AV 锁文件)时,置位不再提前、completed
  // 返回前的补发必须兜住——否则 run 成功线程却永久卡 streaming
  test("#550:终值 append throw 后 completed 补发 run.end{end_turn} 恰一次", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-550-end-turn-"));
    dirs.push(agentDir);
    const runner = await createRunner(agentDir, []);
    const bus = getThreadEventBus(getRuntimeCoreSessionDir("thread-1", agentDir));
    const realPublish = bus.publish.bind(bus);
    let failTerminalOnce = true;
    (bus as unknown as { publish: typeof realPublish }).publish = (threadId, runId, event) => {
      if (failTerminalOnce && (event.detail as { type?: string }).type === "run.end") {
        failTerminalOnce = false; // 只打 projector 终值一枪,补发放行
        throw new Error("EAGAIN: av lock on terminal append");
      }
      return realPublish(threadId, runId, event);
    };

    async function* completedStream(): AsyncIterable<SDKMessage> {
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] }
      } as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        result: "ok"
      } as SDKMessage;
    }

    const result = await runner.runQueryStream(completedStream());

    expect(result).toEqual({ status: "completed" });
    const runEnds = await readBusRunEnds(agentDir, "thread-1");
    expect(runEnds).toHaveLength(1);
    // numTurns:0 是补发指纹(projector 终值带真实 numTurns)
    expect(runEnds[0]!.detail).toMatchObject({
      type: "run.end",
      stopReason: "end_turn",
      isError: false,
      numTurns: 0
    });
  });

  // #550 S1:turn_limited 分支的补发同样要兜住(T7a 后它是 web 清 streaming 的唯一信号)
  test("#550:终值 append throw 后 turn_limited 补发 run.end 恰一次", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-550-max-turns-"));
    dirs.push(agentDir);
    const runner = await createRunner(agentDir, []);
    const bus = getThreadEventBus(getRuntimeCoreSessionDir("thread-1", agentDir));
    const realPublish = bus.publish.bind(bus);
    let failTerminalOnce = true;
    (bus as unknown as { publish: typeof realPublish }).publish = (threadId, runId, event) => {
      if (failTerminalOnce && (event.detail as { type?: string }).type === "run.end") {
        failTerminalOnce = false;
        throw new Error("EAGAIN: av lock on terminal append");
      }
      return realPublish(threadId, runId, event);
    };

    async function* maxTurnsStream(): AsyncIterable<SDKMessage> {
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "partial" }] }
      } as SDKMessage;
      yield {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 3
      } as unknown as SDKMessage;
    }

    const result = await runner.runQueryStream(maxTurnsStream());

    expect(result.status).toBe("turn_limited");
    const runEnds = await readBusRunEnds(agentDir, "thread-1");
    expect(runEnds).toHaveLength(1);
    expect(runEnds[0]!.detail).toMatchObject({
      type: "run.end",
      isError: true
    });
  });
});
