import { describe, expect, test } from "bun:test";
import { createMemoryV2Reranker } from "./rerank";
import type { MemoryV2RecallItem } from "./types";

const items: MemoryV2RecallItem[] = [{
  id: "a",
  kind: "decision",
  scope: "workspace",
  status: "active",
  statement: "Memory architecture uses lexical fallback.",
  path: "a.md",
  citation: "a.md",
  reason: "matched memory entry",
  score: 1
}, {
  id: "b",
  kind: "decision",
  scope: "workspace",
  status: "active",
  statement: "Memory architecture uses semantic reranking.",
  path: "b.md",
  citation: "b.md",
  reason: "matched memory entry",
  score: 1
}];

describe("createMemoryV2Reranker", () => {
  test("tries fallback rerank models when the primary model fails", async () => {
    const models: string[] = [];
    const reranker = createMemoryV2Reranker({
      workspaceSlug: "demo",
      modelRef: "openai/broken-small",
      fallbackModelRefs: ["ollama/qwen2.5:7b"],
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage(params) {
          models.push(params.model);
          if (params.model === "broken-small") {
            throw new Error("remote unavailable");
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ids: ["b", "a"] })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    const ranked = await reranker?.(items, "memory architecture");

    expect(models).toEqual(["broken-small", "qwen2.5:7b"]);
    expect(ranked?.map((item) => item.id)).toEqual(["b", "a"]);
  });
});
