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

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bus 收到的全部骨架 envelope.runId=lifecycle.runId", async () => {
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

  test("live 注入(#285):工具期直通事件经同一条投影链到达总线,主流不经过", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "run-loop-live-inject-"));
    dirs.push(agentDir);
    const threadId = "run-loop-live-inject";
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    const mainStreamSeen: SDKMessage[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      published.push(envelope);
    });

    let inject: ((message: SDKMessage) => void) | undefined;
    let releaseMain: (() => void) | undefined;
    const mainGate = new Promise<void>((resolve) => { releaseMain = resolve; });

    // 模拟工具执行期:第一条消息后主流挂起,此时 SDK 经 onLiveEvent 直通注入
    async function* gatedStream(): AsyncIterable<SDKMessage> {
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "working" }] }
      } as SDKMessage;
      await mainGate;
    }

    const consumption = consumeRuntimeCoreQueryStream({
      query: gatedStream(),
      emit: { onSdkMessage: (message) => mainStreamSeen.push(message) },
      lifecycle: { threadId, sessionDir, runId: "lume-run-live-1" },
      onLiveInject: (register) => { inject = register; }
    });

    // 等 tee 启动(inject 注册)+首条消息投影落盘
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !inject) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    inject?.({
      type: "system",
      subtype: "task_progress",
      task_id: "task_live_1",
      description: "tick",
      session_id: threadId
    } as SDKMessage);

    // 投影泵异步排空:轮询等待 live 事件折叠为 task.progress 骨架事件落总线
    const progressDeadline = Date.now() + 2_000;
    while (
      Date.now() < progressDeadline
      && !published.some((envelope) => JSON.stringify(envelope.detail ?? {}).includes("task.progress"))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    releaseMain?.();
    const result = await consumption;

    expect(result).toEqual({ status: "completed" });
    // 主流只含 generator 产出,live 事件不经主流
    expect(mainStreamSeen).toHaveLength(1);

    const progressEvents = published.filter((envelope) =>
      JSON.stringify(envelope.detail ?? {}).includes("task.progress")
    );
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(new Set(progressEvents.map((envelope) => envelope.runId)))
      .toEqual(new Set(["lume-run-live-1"]));

    // 流结束后注入失效:迟到进度被丢弃且不影响已交付的终值序列
    inject?.({
      type: "system",
      subtype: "task_progress",
      task_id: "task_live_late",
      description: "late tick",
      session_id: threadId
    } as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(published.some((envelope) => JSON.stringify(envelope.detail ?? {}).includes("task_live_late"))).toBe(false);
  });

  test("run 中途抛错:tee 注入投影链,run.end 标 error 而非 aborted(F3)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "run-loop-tee-error-"));
    dirs.push(agentDir);
    const threadId = "run-loop-tee-error";
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      published.push(envelope);
    });

    async function* failingStream(): AsyncIterable<SDKMessage> {
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "partial" }] }
      } as SDKMessage;
      throw new Error("mid-run boom");
    }

    // 主流异常照常向调用方传播
    await expect(consumeRuntimeCoreQueryStream({
      query: failingStream(),
      emit: { onSdkMessage: () => {} },
      lifecycle: { threadId, sessionDir, runId: "lume-run-tee-err-1" }
    })).rejects.toThrow("mid-run boom");

    // 终值唯一且为 error(旧链路误标 aborted)
    const runEnds = published.filter((envelope) => envelope.kind === "run" && envelope.phase === "end");
    expect(runEnds).toHaveLength(1);
    expect(runEnds[0]!.detail).toMatchObject({
      type: "run.end",
      stopReason: "error",
      isError: true,
      result: "mid-run boom"
    });
  });

  test("AbortError 味流 reject:终值保持 aborted 语义,不误标 error(F3 fix round 1)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "run-loop-tee-abort-"));
    dirs.push(agentDir);
    const threadId = "run-loop-tee-abort";
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      published.push(envelope);
    });

    async function* abortingStream(): AsyncIterable<SDKMessage> {
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "partial" }] }
      } as SDKMessage;
      throw new Error("This operation was aborted");
    }

    await expect(consumeRuntimeCoreQueryStream({
      query: abortingStream(),
      emit: { onSdkMessage: () => {} },
      lifecycle: { threadId, sessionDir, runId: "lume-run-tee-abort-1" }
    })).rejects.toThrow("This operation was aborted");

    // abort 味不注入投影链:post-loop 补 aborted(与 LumeRunner abort() 判定对齐)
    const runEnds = published.filter((envelope) => envelope.kind === "run" && envelope.phase === "end");
    expect(runEnds).toHaveLength(1);
    expect(runEnds[0]!.detail).toMatchObject({
      type: "run.end",
      stopReason: "aborted",
      isError: false
    });
  });
});
