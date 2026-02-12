import { describe, expect, test } from "bun:test";
import { chunkMarkdown } from "./memory-chunker";

describe("memory-chunker", () => {
  test("按 token 估算和 overlap 进行分块", () => {
    const content = [
      "line-1 alpha beta",
      "line-2 gamma delta",
      "line-3 epsilon zeta",
      "line-4 eta theta"
    ].join("\n");

    const chunks = chunkMarkdown(content, "MEMORY.md", {
      tokens: 5,
      overlap: 2,
      model: "test-model"
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.model).toBe("test-model");

    for (const chunk of chunks) {
      expect(chunk.id.length).toBe(16);
      expect(chunk.hash.length).toBe(16);
      expect(chunk.text.length).toBeGreaterThan(0);
    }

    const first = chunks[0];
    const second = chunks[1];
    expect(first && second && second.startLine <= first.endLine).toBeTrue();
  });

  test("空内容不产生 chunk", () => {
    const chunks = chunkMarkdown("   \n\n", "MEMORY.md");
    expect(chunks).toEqual([]);
  });
});
