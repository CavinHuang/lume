import { describe, expect, test } from "bun:test";
import {
  THREAD_CACHE_GLOBAL_LIMITS,
  clearThreadFileStateCache,
  getThreadFileStateCache,
} from "./thread-file-state-cache";

describe("thread file state cache registry", () => {
  test("returns one shared instance per thread and drops it on clear", () => {
    const first = getThreadFileStateCache("thread-a");
    expect(getThreadFileStateCache("thread-a")).toBe(first);
    expect(getThreadFileStateCache("thread-b")).not.toBe(first);

    clearThreadFileStateCache("thread-a");
    expect(getThreadFileStateCache("thread-a")).not.toBe(first);

    clearThreadFileStateCache("thread-b");
  });

  test("evicts the least-recently-used thread cache when the thread count cap binds (#655)", () => {
    const saved = { ...THREAD_CACHE_GLOBAL_LIMITS };
    try {
      THREAD_CACHE_GLOBAL_LIMITS.maxThreads = 3;
      THREAD_CACHE_GLOBAL_LIMITS.maxTotalBytes = Number.MAX_SAFE_INTEGER;

      const a = getThreadFileStateCache("t-a");
      const b = getThreadFileStateCache("t-b");
      const c = getThreadFileStateCache("t-c");
      getThreadFileStateCache("t-a"); // 触碰 a → 最久未用变为 b

      getThreadFileStateCache("t-d");

      // 存活线程身份不变；被淘汰线程重建新实例（fail-closed 空缓存）。
      expect(getThreadFileStateCache("t-a")).toBe(a);
      expect(getThreadFileStateCache("t-c")).toBe(c);
      expect(getThreadFileStateCache("t-b")).not.toBe(b);
    } finally {
      Object.assign(THREAD_CACHE_GLOBAL_LIMITS, saved);
      for (const id of ["t-a", "t-b", "t-c", "t-d"]) clearThreadFileStateCache(id);
    }
  });

  test("evicts by aggregate bytes across threads, oldest use first (#655)", () => {
    const saved = { ...THREAD_CACHE_GLOBAL_LIMITS };
    try {
      THREAD_CACHE_GLOBAL_LIMITS.maxThreads = 99;
      THREAD_CACHE_GLOBAL_LIMITS.maxTotalBytes = 50;

      const a = getThreadFileStateCache("b-a");
      a.set("/x.txt", { content: "z".repeat(15), timestamp: 1 }); // 记账 30
      const b = getThreadFileStateCache("b-b");
      b.set("/y.txt", { content: "z".repeat(15), timestamp: 1 }); // 聚合 60 > 50

      // 下一次分发收敛：整条淘汰最久未用的 b-a，而不是逐条目混删。
      const c = getThreadFileStateCache("b-c");

      expect(getThreadFileStateCache("b-b")).toBe(b);
      expect(getThreadFileStateCache("b-c")).toBe(c);
      expect(getThreadFileStateCache("b-a")).not.toBe(a);
    } finally {
      Object.assign(THREAD_CACHE_GLOBAL_LIMITS, saved);
      for (const id of ["b-a", "b-b", "b-c"]) clearThreadFileStateCache(id);
    }
  });
});
