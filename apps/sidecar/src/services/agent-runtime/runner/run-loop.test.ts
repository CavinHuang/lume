import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SdkEventEnvelope } from "@lume/shared";
import {
  consumeRuntimeCoreQueryStream,
  createObservedRuntimeEmitter,
  getRuntimeCoreStreamError,
  normalizeRuntimeCoreQueryPermissionMode
} from "./run-loop";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import { getThreadEventBus } from "../events/thread-event-bus";
import type { LumeRunObserver } from "./run-observer";

async function* stream(messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  for (const message of messages) {
    yield message;
  }
}

describe("runtime-core run loop", () => {
  test("forwards raw messages for observer persistence", async () => {
    const emitted: SDKMessage[] = [];
    const assistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }]
      }
    } as SDKMessage;

    const result = await consumeRuntimeCoreQueryStream({
      query: stream([assistantMessage]),
      emit: {
        onSdkMessage: (message) => emitted.push(message)
      }
    });

    expect(emitted).toEqual([assistantMessage]);
    expect(result).toEqual({ status: "completed" });
  });

  test("returns SDK result errors", async () => {
    const result = await consumeRuntimeCoreQueryStream({
      query: stream([{
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom"]
      } as SDKMessage]),
      emit: {
        onSdkMessage: () => {}
      }
    });

    expect(result).toEqual({
      status: "errored",
      errorMessage: "boom"
    });
  });

  test("returns max-turn SDK results as continuable instead of errored", async () => {
    const result = await consumeRuntimeCoreQueryStream({
      query: stream([{
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        num_turns: 10
      } as SDKMessage]),
      emit: {
        onSdkMessage: () => {}
      }
    });

    expect(result).toEqual({
      status: "turn_limited",
      errorMessage: "Agent SDK 达到最大回合数（10），本轮需要继续执行。"
    });
  });

  test("rejects usage-only streams without renderable output", async () => {
    const result = await consumeRuntimeCoreQueryStream({
      query: stream([{
        type: "result",
        subtype: "success",
        usage: { input_tokens: 12 }
      } as SDKMessage]),
      emit: {
        onSdkMessage: () => {}
      }
    });

    expect(result).toEqual({
      status: "errored",
      errorMessage: "runtime-core 未检测到可渲染输出。"
    });
  });

  test("extracts assistant error text before SDK error code", () => {
    expect(getRuntimeCoreStreamError({
      type: "assistant",
      error: "max_output_tokens",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "token budget exhausted" }]
      }
    } as SDKMessage)).toBe("token budget exhausted");
  });

  test("normalizes unsupported permission modes to default query mode", () => {
    expect(normalizeRuntimeCoreQueryPermissionMode("bypassPermissions")).toBe("bypassPermissions");
    expect(normalizeRuntimeCoreQueryPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(normalizeRuntimeCoreQueryPermissionMode("plan")).toBe("plan");
    expect(normalizeRuntimeCoreQueryPermissionMode(undefined)).toBe("default");
    expect(normalizeRuntimeCoreQueryPermissionMode("default")).toBe("default");
  });

  test("observed emitter emits runtime events from observer-recorded run items", () => {
    const runtimeEvents: unknown[] = [];
    const sdkMessages: SDKMessage[] = [];
    const observer = {
      recordSdkMessage: (
        _message: SDKMessage,
        emitRuntimeEvent?: (event: unknown) => void
      ) => {
        emitRuntimeEvent?.({
          id: "runtime-1",
          type: "assistant.delta",
          threadId: "thread-1",
          runId: "run-1",
          createdAt: "2026-05-11T00:00:00.000Z",
          delta: "from run item"
        });
      }
    } as unknown as LumeRunObserver;

    const emit = createObservedRuntimeEmitter({
      onSdkMessage: (message) => sdkMessages.push(message),
      onRuntimeEvent: (event) => runtimeEvents.push(event),
      onComplete: () => undefined,
      onError: () => undefined,
      onAskUserQuestion: () => undefined,
      onBrowserAuthRequest: () => undefined,
      onToolPermissionRequest: () => undefined
    }, observer);

    const message = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] }
    } as SDKMessage;
    emit.onSdkMessage(message);

    expect(sdkMessages).toEqual([message]);
    expect(runtimeEvents).toEqual([{
      id: "runtime-1",
      type: "assistant.delta",
      threadId: "thread-1",
      runId: "run-1",
      createdAt: "2026-05-11T00:00:00.000Z",
      delta: "from run item"
    }]);
  });
});

describe("tee lifecycle 接线:骨架事件 runId=Lume runId(批次5 Task 6)", () => {
  const dirs: string[] = [];
  const previousFlag = process.env.AGENT_LIFECYCLE_EVENTS;
  const hadFlag = previousFlag !== undefined;

  afterEach(() => {
    if (hadFlag) {
      process.env.AGENT_LIFECYCLE_EVENTS = previousFlag;
    } else {
      delete process.env.AGENT_LIFECYCLE_EVENTS;
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flag on: bus 收到的全部骨架 envelope.runId=lifecycle.runId", async () => {
    process.env.AGENT_LIFECYCLE_EVENTS = "1";
    const agentDir = mkdtempSync(join(tmpdir(), "run-loop-tee-runid-"));
    dirs.push(agentDir);
    const threadId = "run-loop-tee-runid";
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      published.push(envelope);
    });

    const result = await consumeRuntimeCoreQueryStream({
      query: stream([{
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }]
        }
      } as SDKMessage]),
      emit: { onSdkMessage: () => {} },
      lifecycle: { threadId, sessionDir, runId: "lume-run-tee-1" }
    });

    expect(result).toEqual({ status: "completed" });
    // 无 result 终值流:run.start→turn.start→message.start→message.end→turn.end→run.end(aborted)
    const kinds = published.map((envelope) => `${envelope.kind}.${envelope.phase}`);
    expect(kinds).toEqual([
      "run.start", "turn.start", "message.start",
      "message.end", "turn.end", "run.end"
    ]);
    // 全部骨架事件 runId=传入 Lume runId(不再自产 UUID)
    expect(new Set(published.map((envelope) => envelope.runId)))
      .toEqual(new Set(["lume-run-tee-1"]));
  });
});
