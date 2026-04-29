import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@lume/shared";
import type { PiAgentRunParams, PiAgentRuntimeEmitter } from "../../pi-agent/runner/types";
import { getRuntimeCoreSessionDir } from "../../pi-agent/runtime-core/session-store";
import { LumeRunner } from "./lume-runner";
import type { LumeRunState } from "./run-state";

function createTestParams(threadId: string): PiAgentRunParams {
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

function createEmitter(events: string[]): PiAgentRuntimeEmitter {
  return {
    onSdkMessage: (message) => events.push(`sdk:${message.type}`),
    onComplete: () => events.push("complete"),
    onError: (message) => events.push(`error:${message}`),
    onAskUserQuestion: () => {},
    onToolPermissionRequest: () => {}
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

function readTrace(agentDir: string): { spans: Array<{ type: string; name: string; status: string; output?: unknown }> } {
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
