/**
 * PendingRequestRegistry(#580)专属单测(review 补测):该原语收编两处
 * 手写三联并承载精细契约(settle 幂等闸门、superseded 跳过持久化清理、
 * beforeResolve 抛错不阻断 resolve),此前零直接覆盖,abort/superseded/
 * cancelWhere 连消费方测试的间接覆盖都没有。
 */
import { describe, expect, test } from "bun:test";
import { PendingRequestRegistry } from "./pending-request-registry";

interface TestMeta {
  threadId: string;
}

function createRegistry(): PendingRequestRegistry<string, string | null, TestMeta> {
  return new PendingRequestRegistry<string, string | null, TestMeta>();
}

type Registry = PendingRequestRegistry<string, string | null, TestMeta>;
// signal 保持显式位置参数;其余 wait 入参(含三个 value 工厂)均可覆盖。
type WaitOverrides = Omit<Partial<Parameters<Registry["wait"]>[1]>, "signal">;

function baseInput(signal: AbortSignal, overrides: WaitOverrides = {}) {
  return {
    meta: { threadId: "t-1" },
    timeoutMs: 60_000,
    signal,
    abortValue: () => null,
    timeoutValue: () => null,
    supersededValue: () => null,
    ...overrides
  };
}

describe("PendingRequestRegistry", () => {
  test("answered:settle 返回值送达等待方,返回是否存在;二次 settle 幂等", async () => {
    const registry = createRegistry();
    const promise = registry.wait("k1", baseInput(new AbortController().signal));
    expect(registry.settle("k1", "answered")).toBe(true);
    expect(await promise).toBe("answered");
    expect(registry.settle("k1", "again")).toBe(false);
  });

  test("timeout:onTimeout 先于 settle 执行,timeout 值送达且表项清空", async () => {
    const registry = createRegistry();
    const order: string[] = [];
    const promise = registry.wait("k1", baseInput(new AbortController().signal, {
      timeoutMs: 5,
      unref: false,
      onTimeout: () => order.push("onTimeout"),
      timeoutValue: () => "timed-out"
    }));
    expect(await promise).toBe("timed-out");
    expect(order).toEqual(["onTimeout"]);
    expect(registry.list()).toHaveLength(0);
  });

  test("abort 事件:abort 值送达,beforeResolve 以 aborted 理由执行", async () => {
    const registry = createRegistry();
    const controller = new AbortController();
    const reasons: string[] = [];
    const promise = registry.wait("k1", baseInput(controller.signal, {
      beforeResolve: (_value, reason) => {
        reasons.push(reason);
      }
    }));
    controller.abort();
    expect(await promise).toBeNull();
    expect(reasons).toEqual(["aborted"]);
    expect(registry.list()).toHaveLength(0);
  });

  test("预 abort signal:wait 立即以 abort 值结束,beforeResolve 以 aborted 理由执行,不挂到超时", async () => {
    const registry = createRegistry();
    const controller = new AbortController();
    controller.abort();
    let timedOut = false;
    const onTimeout = (): void => {
      timedOut = true;
    };
    const cleaned: Array<{ value: string | null; reason: string }> = [];
    const promise = registry.wait("k1", baseInput(controller.signal, {
      onTimeout,
      beforeResolve: (value, reason) => {
        cleaned.push({ value, reason });
      }
    }));
    expect(await promise).toBeNull();
    expect(timedOut).toBe(false);
    // 核心语义钉死:短路也必须走持久化清理(删除该调用属回归)。
    expect(cleaned).toEqual([{ value: null, reason: "aborted" }]);
    // 表项不应登记。
    expect(registry.list()).toHaveLength(0);
  });

  test("updateMeta:Object.assign 原位 mutate,不存在 key 时静默 no-op", () => {
    const registry = createRegistry();
    // no-op 不抛。
    expect(() => registry.updateMeta("missing", { threadId: "t-x" })).not.toThrow();
    registry.wait("k1", baseInput(new AbortController().signal));
    registry.updateMeta("k1", { threadId: "t-2" });
    expect(registry.getMeta("k1")?.threadId).toBe("t-2");
  });

  test("superseded 重入:旧等待者以 superseded 值结束且跳过 beforeResolve,新等待者正常", async () => {
    const registry = createRegistry();
    const firstCalls: string[] = [];
    const first = registry.wait("k1", baseInput(new AbortController().signal, {
      supersededValue: () => "superseded",
      beforeResolve: () => {
        firstCalls.push("beforeResolve");
      }
    }));
    const second = registry.wait("k1", baseInput(new AbortController().signal, {
      supersededValue: () => "superseded"
    }));
    expect(await first).toBe("superseded");
    // 设计语义(#580 注释钉死):superseded 不做持久化清理。
    expect(firstCalls).toEqual([]);
    expect(registry.settle("k1", "second-answered")).toBe(true);
    expect(await second).toBe("second-answered");
  });

  test("beforeResolve 抛错:仅降级,resolve 必达且表项已清", async () => {
    const registry = createRegistry();
    const promise = registry.wait("k1", baseInput(new AbortController().signal, {
      beforeResolve: () => {
        throw new Error("persist failed");
      }
    }));
    expect(registry.settle("k1", "ok")).toBe(true);
    expect(await promise).toBe("ok");
    expect(registry.list()).toHaveLength(0);
  });

  test("cancelWhere:按 meta 过滤命中项以 cancel 值结束并执行清理,未命中项不受影响", async () => {
    const registry = createRegistry();
    const kept = registry.wait("keep", baseInput(new AbortController().signal, { meta: { threadId: "t-other" } }));
    const cleanedReasons: Array<{ value: string | null; reason: string }> = [];
    const killed = registry.wait("kill", baseInput(new AbortController().signal, {
      beforeResolve: (value, reason) => {
        cleanedReasons.push({ value, reason });
      }
    }));
    registry.cancelWhere(
      (meta) => meta.threadId === "t-1",
      () => "cancelled"
    );
    expect(await killed).toBe("cancelled");
    expect(cleanedReasons).toEqual([{ value: "cancelled", reason: "aborted" }]);
    expect(registry.getMeta("keep")?.threadId).toBe("t-other");
    expect(registry.settle("keep", "late")).toBe(true);
    expect(await kept).toBe("late");
  });
});
