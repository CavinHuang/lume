import { describe, expect, test } from "bun:test";
import { AgentRuntimeKernel, AgentRuntimeKernelQueueConflictError } from "./agent-runtime-kernel";

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
  test("cancelActive 应立即中止当前 dispatch 的共享信号", async () => {
    let aborted = false;
    const errors: string[] = [];
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      execute: async (dispatch) => {
        await new Promise<void>((resolve) => {
          dispatch.abortSignal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
      },
      onDispatchError: (_dispatch, error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    });

    kernel.dispatch({ threadId: "thread-a", userMessage: "run" }, { onError: () => undefined });

    expect(kernel.cancelActive("thread-a")).toBeTrue();
    await kernel.waitForIdleForTest();

    expect(aborted).toBeTrue();
    expect(errors).toEqual([]);
    expect(kernel.cancelActive("thread-a")).toBeFalse();
  });

  test("同一 thread 的 dispatch 应串行执行并报告 queuedCount", async () => {
    const started: string[] = [];
    const queuedCounts: number[] = [];
    const releases = new Map<string, () => void>();
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      createQueuedDispatchId: () => `queue-${queuedCounts.length + 1}`,
      now: () => 123,
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
    expect(second).toEqual({
      ok: true,
      mode: "queued",
      queuedCount: 1,
      queuedMessage: {
        id: "queue-2",
        threadId: "thread-a",
        text: "second",
        createdAt: 123,
        revision: 1,
        status: "queued"
      }
    });
    expect(started).toEqual(["first"]);

    releases.get("first")?.();
    await waitFor(() => started.includes("second"));
    expect(started).toEqual(["first", "second"]);

    releases.get("second")?.();
    await kernel.waitForIdleForTest();

    expect(queuedCounts.at(-1)).toBe(0);
  });

  test("后台续跑排在用户消息之后", async () => {
    const started: string[] = [];
    let release!: () => void;
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        if (dispatch.input.userMessage === "first") {
          await new Promise<void>((resolve) => { release = resolve; });
        }
      },
      onQueuedCountChange: () => undefined,
      onDispatchError: () => undefined
    });

    kernel.dispatch({ threadId: "thread-a", userMessage: "first" }, { onError: () => undefined });
    kernel.dispatch(
      { threadId: "thread-a", userMessage: "background wake" },
      { onError: () => undefined },
      { priority: "background" }
    );
    kernel.dispatch({ threadId: "thread-a", userMessage: "user message" }, { onError: () => undefined });

    release();
    await waitFor(() => started.includes("background wake"));
    expect(started).toEqual(["first", "user message", "background wake"]);
    await kernel.waitForIdleForTest();
  });

  test("listQueued 应返回队列项快照并支持重排执行顺序", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let nextId = 1;
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      createQueuedDispatchId: () => `queued-${nextId++}`,
      now: () => 456,
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        await new Promise<void>((resolve) => {
          releases.set(dispatch.input.userMessage, resolve);
        });
      },
      onQueuedCountChange: () => undefined,
      onDispatchError: () => undefined
    });

    kernel.dispatch({ threadId: "thread-a", userMessage: "first" }, { onError: () => undefined });
    const second = kernel.dispatch({ threadId: "thread-a", userMessage: "second" }, { onError: () => undefined });
    const third = kernel.dispatch({ threadId: "thread-a", userMessage: "third" }, { onError: () => undefined });

    expect(kernel.listQueued("thread-a").map((item) => item.text)).toEqual(["second", "third"]);

    kernel.reorderQueued("thread-a", [
      third.queuedMessage?.id ?? "",
      second.queuedMessage?.id ?? ""
    ]);

    expect(kernel.listQueued("thread-a").map((item) => item.text)).toEqual(["third", "second"]);

    releases.get("first")?.();
    await waitFor(() => started.includes("third"));
    releases.get("third")?.();
    await waitFor(() => started.includes("second"));
    releases.get("second")?.();
    await kernel.waitForIdleForTest();

    expect(started).toEqual(["first", "third", "second"]);
  });

  test("removeQueued 应移除未执行项并返回该 dispatch", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let nextId = 1;
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      createQueuedDispatchId: () => `queued-${nextId++}`,
      now: () => 789,
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        await new Promise<void>((resolve) => {
          releases.set(dispatch.input.userMessage, resolve);
        });
      },
      onQueuedCountChange: () => undefined,
      onDispatchError: () => undefined
    });

    kernel.dispatch({ threadId: "thread-a", userMessage: "first" }, { onError: () => undefined });
    const second = kernel.dispatch({ threadId: "thread-a", userMessage: "second" }, { onError: () => undefined });
    const third = kernel.dispatch({ threadId: "thread-a", userMessage: "third" }, { onError: () => undefined });

    const removed = kernel.removeQueued("thread-a", second.queuedMessage?.id ?? "");

    expect(removed?.input.userMessage).toBe("second");
    expect(kernel.listQueued("thread-a").map((item) => item.text)).toEqual(["third"]);

    releases.get("first")?.();
    await waitFor(() => started.includes("third"));
    releases.get("third")?.();
    await kernel.waitForIdleForTest();

    expect(started).toEqual(["first", "third"]);
  });

  test("prependQueuedDispatches 应把未消费项恢复到队首", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let nextId = 1;
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      createQueuedDispatchId: () => `queued-${nextId++}`,
      now: () => 1000,
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        await new Promise<void>((resolve) => {
          releases.set(dispatch.input.userMessage, resolve);
        });
      },
      onQueuedCountChange: () => undefined,
      onDispatchError: () => undefined
    });

    kernel.dispatch({ threadId: "thread-a", userMessage: "first" }, { onError: () => undefined });
    const guidance = kernel.dispatch({ threadId: "thread-a", userMessage: "guidance" }, { onError: () => undefined });
    kernel.dispatch({ threadId: "thread-a", userMessage: "normal-next" }, { onError: () => undefined });

    const removed = kernel.removeQueued("thread-a", guidance.queuedMessage?.id ?? "");
    expect(removed).toBeTruthy();

    kernel.prependQueuedDispatches("thread-a", removed ? [removed] : []);

    expect(kernel.listQueued("thread-a").map((item) => item.text)).toEqual(["guidance", "normal-next"]);

    releases.get("first")?.();
    await waitFor(() => started.includes("guidance"));
    releases.get("guidance")?.();
    await waitFor(() => started.includes("normal-next"));
    releases.get("normal-next")?.();
    await kernel.waitForIdleForTest();

    expect(started).toEqual(["first", "guidance", "normal-next"]);
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

  test("队列 mutation 使用 revision/CAS，冲突不修改原队列", async () => {
    let release!: () => void;
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      execute: async (dispatch) => dispatch.input.userMessage === "first"
        ? new Promise<void>((resolve) => { release = resolve; })
        : undefined,
      onDispatchError: () => undefined,
    });
    kernel.dispatch({ threadId: "thread-a", userMessage: "first" }, { onError: () => undefined });
    const queued = kernel.dispatch({ threadId: "thread-a", userMessage: "queued" }, { onError: () => undefined });
    const revision = kernel.getQueueRevision("thread-a");

    kernel.updateQueued("thread-a", queued.queuedMessage!.id, revision, { userMessage: "updated" });
    expect(kernel.listQueued("thread-a")[0]?.text).toBe("updated");
    expect(() => kernel.removeQueued("thread-a", queued.queuedMessage!.id, revision))
      .toThrow(AgentRuntimeKernelQueueConflictError);
    expect(kernel.listQueued("thread-a")[0]?.text).toBe("updated");

    release();
    await kernel.waitForIdleForTest();
  });

  test("队首校验失败应暂停 FIFO，更新后从原队首恢复", async () => {
    const started: string[] = [];
    let release!: () => void;
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      validateQueued: async (dispatch) => {
        if (dispatch.input.userMessage === "bad") throw new Error("capability_changed");
      },
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        if (dispatch.input.userMessage === "first") {
          await new Promise<void>((resolve) => { release = resolve; });
        }
      },
      onDispatchError: () => undefined,
    });
    kernel.dispatch({ threadId: "thread-a", userMessage: "first" }, { onError: () => undefined });
    const bad = kernel.dispatch({ threadId: "thread-a", userMessage: "bad" }, { onError: () => undefined });
    kernel.dispatch({ threadId: "thread-a", userMessage: "later" }, { onError: () => undefined });

    release();
    await waitFor(() => kernel.listQueued("thread-a")[0]?.status === "blocked");
    expect(started).toEqual(["first"]);
    expect(kernel.listQueued("thread-a").map((item) => item.text)).toEqual(["bad", "later"]);

    kernel.updateQueued(
      "thread-a",
      bad.queuedMessage!.id,
      kernel.getQueueRevision("thread-a"),
      { userMessage: "recovered" },
    );
    await kernel.waitForIdleForTest();
    expect(started).toEqual(["first", "recovered", "later"]);
  });

  test("retryQueued 应将 blocked 队首重置为 queued 并重新派发", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let blockedOnce = false;
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      createQueuedDispatchId: () => `queue-${Math.random().toString(36).slice(2)}`,
      now: () => 200,
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        await new Promise<void>((resolve) => {
          releases.set(dispatch.input.userMessage, resolve);
        });
      },
      validateQueued: async (dispatch) => {
        // 首次校验失败以触发 blocked;retry 后放行,模拟用户已修复阻塞条件
        if (dispatch.input.userMessage === "blocked-one" && !blockedOnce) {
          blockedOnce = true;
          throw new Error("校验失败");
        }
      },
      onQueuedCountChange: () => undefined,
      onDispatchError: () => undefined,
    });

    // 占据 active,让第二条进入队列
    kernel.dispatch({ threadId: "t-retry", userMessage: "running" }, { onError: () => undefined });
    const queued = kernel.dispatch({ threadId: "t-retry", userMessage: "blocked-one" }, { onError: () => undefined });
    expect(queued.mode).toBe("queued");

    // 释放 running,触发 blocked-one 校验失败 -> blocked
    releases.get("running")!();
    await waitFor(() => kernel.listQueued("t-retry").some((item) => item.status === "blocked"));
    const blocked = kernel.listQueued("t-retry").find((item) => item.status === "blocked")!;
    expect(blocked.blockedReason).toContain("校验失败");

    // retry 重置(scheduleStartNext 会同步推进至 validating,故只断言稳定的可观测效果)
    const retried = kernel.retryQueued("t-retry", blocked.id, kernel.getQueueRevision("t-retry"));
    expect(retried).toBeTruthy();
    expect(retried?.blockedReason).toBeUndefined();

    await waitFor(() => started.includes("blocked-one"));
    expect(started).toContain("blocked-one");
    releases.get("blocked-one")!();
    await kernel.waitForIdleForTest();
  });

  test("retryQueued 对非 blocked 项返回 null", () => {
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      execute: async () => undefined,
      onDispatchError: () => undefined,
    });
    const sent = kernel.dispatch({ threadId: "t-null", userMessage: "first" }, { onError: () => undefined });
    // first 已 sent(active 中,不在队列)
    expect(kernel.retryQueued("t-null", "not-queued", 0)).toBeNull();
    void sent;
  });

  test("pauseQueue 暂停后 startNextQueued 不派发,resumeQueue 恢复派发", async () => {
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      createQueuedDispatchId: () => `queue-${Math.random().toString(36).slice(2)}`,
      now: () => 300,
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
        await new Promise<void>((resolve) => { releases.set(dispatch.input.userMessage, resolve); });
      },
      onQueuedCountChange: () => undefined,
      onDispatchError: () => undefined,
    });

    kernel.dispatch({ threadId: "t-pause", userMessage: "running" }, { onError: () => undefined });
    kernel.dispatch({ threadId: "t-pause", userMessage: "next" }, { onError: () => undefined });
    await waitFor(() => started.includes("running"));

    kernel.pauseQueue("t-pause");
    expect(kernel.isPaused("t-pause")).toBe(true);
    releases.get("running")!();

    await new Promise((r) => setTimeout(r, 20));
    expect(started).not.toContain("next");

    kernel.resumeQueue("t-pause");
    expect(kernel.isPaused("t-pause")).toBe(false);
    await waitFor(() => started.includes("next"));

    releases.get("next")!();
  });

  test("isThreadOccupied 占用期间派发入队，notifyThreadReleased 唤醒（#398）", async () => {
    const started: string[] = [];
    let occupied = true;
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      isThreadOccupied: () => occupied,
      execute: async (dispatch) => {
        started.push(dispatch.input.userMessage);
      },
      onDispatchError: () => undefined
    });

    // 外部占用中：新派发必须入队而非并发启动
    const result = kernel.dispatch({ threadId: "thread-x", userMessage: "queued" }, { onError: () => undefined });
    expect(result.mode).toBe("queued");
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual([]);

    occupied = false;
    kernel.notifyThreadReleased("thread-x");
    await waitFor(() => started.includes("queued"));
  });

  test("waitForThreadIdle 等待 execute 完成后返回", async () => {
    let resolveRun!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const kernel = new AgentRuntimeKernel<TestInput, TestEmitter>({
      execute: async () => {
        await gate;
      },
      onDispatchError: () => undefined
    });

    kernel.dispatch({ threadId: "thread-y", userMessage: "run" }, { onError: () => undefined });
    let idle = false;
    const waiting = kernel.waitForThreadIdle("thread-y").then(() => {
      idle = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(idle).toBe(false);

    resolveRun();
    await waiting;
    expect(idle).toBe(true);
  });
});
