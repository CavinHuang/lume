import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getReadingWereadCachePath } from "../infra/config-paths";
import {
  cachedWereadCall,
  clearWereadCache
} from "./weread-cache-service";

describe("weread-cache-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-weread-cache-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    clearWereadCache();
  });

  afterEach(() => {
    clearWereadCache();
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("persists WeRead responses and reuses them within ttl", async () => {
    let loadCount = 0;
    const first = await cachedWereadCall(
      "shelf",
      async () => {
        loadCount += 1;
        return { books: [{ title: "好吗好的" }] };
      },
      { now: () => 1_000, ttlMs: 60_000 }
    );
    const second = await cachedWereadCall(
      "shelf",
      async () => {
        loadCount += 1;
        return { books: [{ title: "重新请求" }] };
      },
      { now: () => 2_000, ttlMs: 60_000 }
    );

    expect(first).toEqual({ books: [{ title: "好吗好的" }] });
    expect(second).toEqual(first);
    expect(loadCount).toBe(1);
    expect(existsSync(getReadingWereadCachePath())).toBeTrue();
  });

  test("keeps separate entries when WeRead calls fill the cache concurrently", async () => {
    await Promise.all([
      cachedWereadCall("shelf", async () => ({ books: [{ title: "书架" }] }), { now: () => 1_000, ttlMs: 60_000 }),
      cachedWereadCall("notebooks", async () => ({ notebooks: [{ title: "笔记本" }] }), { now: () => 1_000, ttlMs: 60_000 })
    ]);

    let loadCount = 0;
    await expect(cachedWereadCall("shelf", async () => {
      loadCount += 1;
      return { books: [{ title: "不应请求书架" }] };
    }, { now: () => 2_000, ttlMs: 60_000 })).resolves.toEqual({ books: [{ title: "书架" }] });
    await expect(cachedWereadCall("notebooks", async () => {
      loadCount += 1;
      return { notebooks: [{ title: "不应请求笔记本" }] };
    }, { now: () => 2_000, ttlMs: 60_000 })).resolves.toEqual({ notebooks: [{ title: "笔记本" }] });
    expect(loadCount).toBe(0);
  });

  test("returns stale WeRead data immediately and refreshes it in the background", async () => {
    await cachedWereadCall(
      "shelf",
      async () => ({ books: [{ title: "旧书架" }] }),
      { now: () => 1_000, ttlMs: 100 }
    );

    let refreshLoadCount = 0;
    let resolveRefresh: (value: { books: Array<{ title: string }> }) => void = () => {};
    const refreshValue = new Promise<{ books: Array<{ title: string }> }>((resolve) => {
      resolveRefresh = resolve;
    });
    const stalePromise = cachedWereadCall(
      "shelf",
      async () => {
        refreshLoadCount += 1;
        return refreshValue;
      },
      { now: () => 1_200, ttlMs: 100 }
    );
    const immediate = await Promise.race([
      stalePromise,
      Promise.resolve("__pending__")
    ]);
    resolveRefresh({ books: [{ title: "新书架" }] });
    await stalePromise.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(immediate).toEqual({ books: [{ title: "旧书架" }] });
    expect(refreshLoadCount).toBe(1);
    await expect(cachedWereadCall(
      "shelf",
      async () => ({ books: [{ title: "不应请求" }] }),
      { now: () => 1_250, ttlMs: 100 }
    )).resolves.toEqual({ books: [{ title: "新书架" }] });
  });

  test("does not repopulate cache when it is cleared during a background refresh", async () => {
    await cachedWereadCall(
      "shelf",
      async () => ({ books: [{ title: "旧书架" }] }),
      { now: () => 1_000, ttlMs: 100 }
    );

    let resolveRefresh: (value: { books: Array<{ title: string }> }) => void = () => {};
    const refreshValue = new Promise<{ books: Array<{ title: string }> }>((resolve) => {
      resolveRefresh = resolve;
    });
    await expect(cachedWereadCall(
      "shelf",
      async () => refreshValue,
      { now: () => 1_200, ttlMs: 100 }
    )).resolves.toEqual({ books: [{ title: "旧书架" }] });

    clearWereadCache();
    resolveRefresh({ books: [{ title: "旧 key 的刷新结果" }] });
    await Promise.resolve();
    await Promise.resolve();

    let loadCount = 0;
    await expect(cachedWereadCall(
      "shelf",
      async () => {
        loadCount += 1;
        return { books: [{ title: "新 key 的请求结果" }] };
      },
      { now: () => 1_300, ttlMs: 100 }
    )).resolves.toEqual({ books: [{ title: "新 key 的请求结果" }] });
    expect(loadCount).toBe(1);
  });
});
