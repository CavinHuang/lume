import { describe, expect, test } from "bun:test";
import {
  extractExplicitMemoryCandidates,
  extractMemoryCandidatesWithLlm,
  resolveMemoryExtractionModelRef
} from "./extraction";

describe("extractExplicitMemoryCandidates", () => {
  test("extracts explicit preference intent", () => {
    expect(extractExplicitMemoryCandidates({
      text: "以后默认用中文回答",
      workspaceSlug: "demo"
    })).toEqual([expect.objectContaining({
      kind: "preference",
      targetScope: "global",
      statement: "默认用中文回答"
    })]);
  });

  test("extracts explicit remember intent as workspace fact", () => {
    expect(extractExplicitMemoryCandidates({
      text: "记住 Lume Memory V2 使用 Markdown 作为事实源",
      workspaceSlug: "demo"
    })).toEqual([expect.objectContaining({
      kind: "fact",
      targetScope: "workspace",
      statement: "Lume Memory V2 使用 Markdown 作为事实源"
    })]);
  });

  test("suppresses durable extraction when user says not to remember", () => {
    expect(extractExplicitMemoryCandidates({
      text: "不要记住这个：临时 token 是 abc"
    })).toEqual([]);
  });

  test("uses LLM extraction when a small model provider is supplied", async () => {
    const calls: Array<{ system: string }> = [];
    const candidates = await extractMemoryCandidatesWithLlm({
      text: "以后默认用中文回答",
      workspaceSlug: "demo",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage(params) {
          calls.push({ system: params.system });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                shouldExtract: true,
                candidates: [{
                  kind: "preference",
                  targetScope: "global",
                  statement: "User prefers Chinese responses by default.",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "以后默认用中文回答",
                  reason: "User stated a durable language preference.",
                  tags: ["language"]
                }]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain("Gatekeeper");
    expect(calls[0]?.system).toContain("source_found");
    expect(candidates).toEqual([expect.objectContaining({
      kind: "preference",
      targetScope: "global",
      statement: "User prefers Chinese responses by default.",
      evidence: expect.objectContaining({
        quote: "以后默认用中文回答"
      })
    })]);
  });

  test("trusts the LLM gate when it decides not to extract", async () => {
    const candidates = await extractMemoryCandidatesWithLlm({
      text: "以后默认用中文回答",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage() {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                shouldExtract: false,
                candidates: []
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(candidates).toEqual([]);
  });

  test("rejects LLM candidates that do not cite user source text", async () => {
    const candidates = await extractMemoryCandidatesWithLlm({
      text: "以后默认用中文回答",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage() {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                shouldExtract: true,
                candidates: [{
                  kind: "preference",
                  targetScope: "global",
                  statement: "User prefers English.",
                  confidence: "high",
                  sourceRole: "assistant",
                  sourceText: "I will answer in English.",
                  reason: "Bad source."
                }]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(candidates).toEqual([]);
  });

  test("falls back to explicit extraction when LLM extraction is unavailable", async () => {
    const candidates = await extractMemoryCandidatesWithLlm({
      text: "记住 Lume 使用 Memory V2",
      workspaceSlug: "demo",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => {
        throw new Error("missing key");
      }
    });

    expect(candidates).toEqual([expect.objectContaining({
      statement: "Lume 使用 Memory V2"
    })]);
  });

  test("resolves memory extraction model ref from memory config", () => {
    expect(resolveMemoryExtractionModelRef({
      memory: {
        extraction: {
          modelRef: "openai/gpt-5-mini"
        }
      }
    })).toBe("openai/gpt-5-mini");
    expect(resolveMemoryExtractionModelRef({
      memory: {
        extractionModelRef: "deepseek/deepseek-chat"
      }
    })).toBe("deepseek/deepseek-chat");
  });
});
