import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@lume/shared";
import type { AgentRuntimeRunParams, AgentRuntimeEmitter } from "./types";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import { LumeRunner, resolveRuntimeCoreMaxTurns } from "./lume-runner";
import type { LumeRunState } from "./run-state";
import { createMemoryV2Store } from "../../memory-v2/markdown-store";
import { getMemoryV2ScopePaths } from "../../memory-v2/paths";

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
    apiKey: "test-key"
  } as Parameters<typeof LumeRunner.create>[0]["prepared"];
}

function createEmitter(events: string[]): AgentRuntimeEmitter {
  return {
    onSdkMessage: (message) => events.push(`sdk:${message.type}`),
    onComplete: () => events.push("complete"),
    onError: (message) => events.push(`error:${message}`),
    onAskUserQuestion: () => {},
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
  const traceFile = readdirSync(join(sessionDir, "traces"))
    .find((file) => file.endsWith(".json"));
  if (!traceFile) {
    throw new Error("trace not found");
  }
  return JSON.parse(readFileSync(join(sessionDir, "traces", traceFile), "utf8"));
}

describe("LumeRunner", () => {
  const dirs: string[] = [];

  afterEach(() => {
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
      const entries = createMemoryV2Store().listEntries({
        workspaceSlug: "demo",
        scopes: ["global"],
        includeStatuses: ["active"]
      });

      expect(result).toEqual({ status: "completed" });
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
      "runtime:assistant.delta",
      "runtime:run.completed",
      "complete"
    ]);
  });

  test("complete emits RuntimeEvents", async () => {
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

    expect(events).toEqual([
      "sdk:assistant",
      "runtime:assistant.delta",
      "runtime:run.completed",
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
        execute: async (event) => {
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

    expect(seen).toEqual(["run.beforeStart", "run.afterComplete"]);
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

  test("fires failure hook and preserves original failure", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-fail-"));
    dirs.push(agentDir);
    const seen: string[] = [];
    const runner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter([]),
      workflowHooks: {
        execute: async (event) => {
          seen.push(event.event);
          if (event.event === "run.afterFailure") {
            expect(event.errorMessage).toBe("model failed");
            return { effects: [], errors: [] };
          }
          return { effects: [], errors: [] };
        }
      } as any
    });

    const result = await runner.fail("model failed");

    expect(seen).toEqual(["run.beforeStart", "run.afterFailure"]);
    expect(result).toEqual({ status: "errored", errorMessage: "model failed" });
  });

  test("preserves original failure when failure hook throws or returns errors", async () => {
    for (const mode of ["throw", "errors"] as const) {
      const agentDir = mkdtempSync(join(tmpdir(), `lume-runner-hooks-fail-${mode}-`));
      dirs.push(agentDir);
      const runner = await LumeRunner.create({
        params: createTestParams("thread-1"),
        prepared: createPrepared(agentDir),
        emit: createRuntimeEventEmitter([]),
        workflowHooks: {
          execute: async (event) => {
            if (event.event !== "run.afterFailure") return { effects: [], errors: [] };
            if (mode === "throw") throw new Error("hook failed");
            return { effects: [], errors: [{ contributionId: "failure", message: "hook failed" }] };
          }
        } as any
      });

      const result = await runner.fail("model failed");

      expect(result).toEqual({ status: "errored", errorMessage: "model failed" });
    }
  });

  test("finalizeError also fires failure hook without replacing the thrown error", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-hooks-finalize-error-"));
    dirs.push(agentDir);
    const seen: string[] = [];
    const runner = await LumeRunner.create({
      params: createTestParams("thread-1"),
      prepared: createPrepared(agentDir),
      emit: createRuntimeEventEmitter([]),
      workflowHooks: {
        execute: async (event) => {
          seen.push(event.event);
          if (event.event === "run.afterFailure") {
            expect(event.errorMessage).toBe("model failed");
            throw new Error("hook failed");
          }
          return { effects: [], errors: [] };
        }
      } as any
    });

    await expect(runner.finalizeError(new Error("model failed"))).resolves.toBeUndefined();
    expect(seen).toEqual(["run.beforeStart", "run.afterFailure"]);
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
      num_turns: 20
    } as SDKMessage]));

    expect(result).toEqual({
      status: "turn_limited",
      errorMessage: "Agent SDK 达到最大回合数（20），本轮需要继续执行。"
    });
    expect(events).toEqual(["sdk:result", "runtime:usage.updated", "runtime:run.turn_limited"]);
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

  test("runRuntimeSession registers abort, runs query, updates thread meta, and disposes session", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-runner-session-"));
    dirs.push(agentDir);
    const events: string[] = [];
    const runner = await createRunner(agentDir, events);
    const lifecycle: string[] = [];
    let registeredAbort: (() => Promise<void>) | undefined;

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
    expect(events).toEqual(["sdk:assistant", "complete"]);
    expect(lifecycle).toEqual([
      "registerAbort",
      "setModel:model-1",
      "thinking:4096",
      "dispose",
      "unregisterAbort",
      "interrupt"
    ]);
    expect(readOnlyRunState(agentDir).status).toBe("completed");
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
  });
});
