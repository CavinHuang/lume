import { describe, expect, test } from "bun:test";
import { AgentRuntimeKernel } from "./agent-runtime-kernel";

interface TestInput {
  threadId: string;
  userMessage: string;
}

interface TestEmitter {
  onError: (message: string) => void;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

describe("AgentRuntimeKernel", () => {
  test("同一 thread 的 dispatch 应串行执行并报告 queuedCount", async () => {
    const started: string[] = [];
    const queuedCounts: number[] = [];
    const releases = new Map<string, () => void>();
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        await new Promise<void>((resolve) => {
          releases.set(dispatch.input.userMessage, resolve);
        });
      },
      onQueuedCountChange: (_threadId, count) => {
        queuedCounts.push(count);
      },
      onDispatchError: () => undefined
    });

    const first = kernel.dispatch({ threadId: "thread-a", userMessage: "first" }, { onError: () => undefined });
    const second = kernel.dispatch({ threadId: "thread-a", userMessage: "second" }, { onError: () => undefined });

    expect(first).toEqual({ ok: true, mode: "sent", queuedCount: 0 });
    expect(second).toEqual({ ok: true, mode: "queued", queuedCount: 1 });
    expect(started).toEqual(["first"]);

    releases.get("first")?.();
    await waitFor(() => started.includes("second"));
    expect(started).toEqual(["first", "second"]);

    releases.get("second")?.();
    await kernel.waitForIdleForTest();

    expect(queuedCounts.at(-1)).toBe(0);
  });

  test("当前 dispatch 失败后应通知错误并继续执行队列", async () => {
    const started: string[] = [];
    const errors: string[] = [];
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        if (dispatch.input.userMessage === "first") {
          throw new Error("first failed");
        }
      },
      onQueuedCountChange: () => undefined,
      onDispatchError: (dispatch, error) => {
        dispatch.emit.onError(error instanceof Error ? error.message : String(error));
      }
    });

    kernel.dispatch({ threadId: "thread-a", userMessage: "first" }, { onError: (message) => errors.push(message) });
    kernel.dispatch({ threadId: "thread-a", userMessage: "second" }, { onError: (message) => errors.push(message) });

    await kernel.waitForIdleForTest();

    expect(started).toEqual(["first", "second"]);
    expect(errors).toEqual(["first failed"]);
  });
});
