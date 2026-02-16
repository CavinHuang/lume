import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { embedTextWithCache, embedTextsWithCache } from "./embedding-ops";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE embedding_cache (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);
  return db;
}

describe("embedding-ops", () => {
  test("embedTextWithCache 应复用缓存避免重复调用", async () => {
    const db = setupDb();
    let calls = 0;

    const first = await embedTextWithCache({
      text: "hello",
      hashText: (text) => `h:${text}`,
      cache: { db, provider: "p", model: "m", providerKey: "k" },
      embedSingle: async () => {
        calls += 1;
        return [1, 2, 3];
      },
      fallbackLite: () => [0]
    });

    const second = await embedTextWithCache({
      text: "hello",
      hashText: (text) => `h:${text}`,
      cache: { db, provider: "p", model: "m", providerKey: "k" },
      embedSingle: async () => {
        calls += 1;
        return [9, 9, 9];
      },
      fallbackLite: () => [0]
    });

    expect(first).toEqual([1, 2, 3]);
    expect(second).toEqual([1, 2, 3]);
    expect(calls).toBe(1);

    db.close();
  });

  test("embedTextsWithCache 在 batch 失败时回退 lite", async () => {
    const db = setupDb();

    const result = await embedTextsWithCache({
      texts: ["a", "b"],
      hashText: (text) => `h:${text}`,
      cache: { db, provider: "p", model: "m", providerKey: "k" },
      embedBatch: async () => {
        throw new Error("batch fail");
      },
      embedSingle: async () => [99],
      fallbackLite: (text) => [text.length]
    });

    expect(result).toEqual([[1], [1]]);

    db.close();
  });
});
