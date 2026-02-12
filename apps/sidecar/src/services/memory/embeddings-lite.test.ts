import { describe, expect, test } from "bun:test";
import { createLiteEmbedding } from "./embeddings-lite";

describe("embeddings-lite", () => {
  test("应稳定输出固定维度向量", () => {
    const a = createLiteEmbedding("hello world", 64);
    const b = createLiteEmbedding("hello world", 64);
    expect(a.length).toBe(64);
    expect(a).toEqual(b);
  });

  test("应支持中文 token", () => {
    const zh = createLiteEmbedding("记忆 系统", 64);
    const en = createLiteEmbedding("memory system", 64);
    expect(zh.some((item) => item !== 0)).toBeTrue();
    expect(en.some((item) => item !== 0)).toBeTrue();
  });
});
