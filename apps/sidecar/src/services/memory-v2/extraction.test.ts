import { describe, expect, test } from "bun:test";
import {
  extractExplicitMemoryCandidates,
  extractMemoryBatchCandidatesWithLlm,
  extractMemoryCandidatesWithLlm,
  resolveMemoryExtractionModelRef
} from "./extraction";

describe("extractExplicitMemoryCandidates", () => {
  test("extracts preferred-name profile memory as global by default", () => {
    expect(extractExplicitMemoryCandidates({
      text: "叫我 Mason",
      workspaceSlug: "demo"
    })).toEqual([expect.objectContaining({
      kind: "preference",
      targetScope: "global",
      statement: "用户希望被称呼为 Mason",
      claim: {
        subject: "user/self",
        predicate: "preferred_name",
        object: "Mason"
      },
      tags: expect.arrayContaining(["profile", "identity", "preferred-name"])
    })]);
  });

  test("extracts assistant preferred-name claim without changing product identity", () => {
    expect(extractExplicitMemoryCandidates({
      text: "就想叫你 Alice",
      workspaceSlug: "demo"
    })).toEqual([expect.objectContaining({
      kind: "preference",
      targetScope: "global",
      statement: "用户希望用 Alice 称呼助手",
      claim: {
        subject: "assistant/self",
        predicate: "preferred_name",
        object: "Alice"
      },
      tags: expect.arrayContaining(["profile", "identity", "preferred-name"])
    })]);
  });

  test("extracts workspace-scoped preferred-name when explicitly limited", () => {
    expect(extractExplicitMemoryCandidates({
      text: "在这个工作区叫我 Mason",
      workspaceSlug: "demo"
    })).toEqual([expect.objectContaining({
      kind: "preference",
      targetScope: "workspace",
      statement: "用户希望在当前工作区被称呼为 Mason",
      claim: {
        subject: "user/self",
        predicate: "preferred_name",
        object: "Mason"
      },
      tags: expect.arrayContaining(["profile", "identity", "preferred-name"]),
      appliesWhen: { workspaceSlug: "demo" }
    })]);
  });

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

  test("extracts explicit writing-style memory with a voice claim", () => {
    expect(extractExplicitMemoryCandidates({
      text: "记住：我的写作风格偏好简洁、有温度",
      workspaceSlug: "demo"
    })).toEqual([expect.objectContaining({
      kind: "preference",
      targetScope: "global",
      statement: "我的写作风格偏好简洁、有温度",
      tags: expect.arrayContaining(["voice", "writing-style"]),
      claim: {
        subject: "user/self",
        predicate: "writing_style",
        object: "简洁、有温度"
      }
    })]);
  });

  test("extracts explicit remember intent as workspace fact", () => {
    expect(extractExplicitMemoryCandidates({
      text: "记住 Lume Memory V2 使用 Markdown 作为事实源",
      workspaceSlug: "demo"
    })).toEqual([expect.objectContaining({
      kind: "fact",
      targetScope: "workspace",
      statement: "Lume Memory V2 使用 Markdown 作为事实源",
      claim: {
        subject: "workspace/default",
        predicate: "source_of_truth",
        object: "Markdown"
      }
    })]);
  });

  test("extracts multiple explicit memories from one text", () => {
    expect(extractExplicitMemoryCandidates({
      text: "叫我 Mason。以后默认用中文回答",
      workspaceSlug: "demo"
    })).toEqual([
      expect.objectContaining({
        statement: "用户希望被称呼为 Mason",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      }),
      expect.objectContaining({
        kind: "preference",
        targetScope: "global",
        statement: "默认用中文回答"
      })
    ]);
  });

  test("extracts multiple explicit memories joined without punctuation", () => {
    expect(extractExplicitMemoryCandidates({
      text: "叫我 Mason 以后默认用中文回答",
      workspaceSlug: "demo"
    })).toEqual([
      expect.objectContaining({
        statement: "用户希望被称呼为 Mason",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      }),
      expect.objectContaining({
        kind: "preference",
        targetScope: "global",
        statement: "默认用中文回答"
      })
    ]);
  });

  test("extracts assistant name and writing style from one explicit text", () => {
    expect(extractExplicitMemoryCandidates({
      text: "就想叫你 Alice。记住：我的写作风格偏好简洁、有温度",
      workspaceSlug: "demo"
    })).toEqual([
      expect.objectContaining({
        statement: "用户希望用 Alice 称呼助手",
        claim: {
          subject: "assistant/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      }),
      expect.objectContaining({
        statement: "我的写作风格偏好简洁、有温度",
        tags: expect.arrayContaining(["voice", "writing-style"]),
        claim: {
          subject: "user/self",
          predicate: "writing_style",
          object: "简洁、有温度"
        }
      })
    ]);
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
                  tags: ["language"],
                  claim: {
                    subject: "user/self",
                    predicate: "preference",
                    object: "默认用中文回答"
                  }
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
      claim: {
        subject: "user/self",
        predicate: "preference",
        object: "默认用中文回答"
      },
      evidence: expect.objectContaining({
        quote: "以后默认用中文回答"
      })
    })]);
  });

  test("keeps explicit single-message claims when the LLM extracts a different claim", async () => {
    const candidates = await extractMemoryCandidatesWithLlm({
      text: "叫我 Mason 以后默认用中文回答",
      workspaceSlug: "demo",
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
                  statement: "用户偏好默认用中文回答",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "以后默认用中文回答",
                  reason: "User stated a durable language preference.",
                  claim: {
                    subject: "user/self",
                    predicate: "preference",
                    object: "默认用中文回答"
                  }
                }]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        statement: "用户偏好默认用中文回答",
        claim: {
          subject: "user/self",
          predicate: "preference",
          object: "默认用中文回答"
        }
      }),
      expect.objectContaining({
        statement: "用户希望被称呼为 Mason",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      })
    ]);
  });

  test("uses LLM batch extraction with per-source citations", async () => {
    const calls: Array<{ userContent: string }> = [];
    const candidates = await extractMemoryBatchCandidatesWithLlm({
      sources: [
        {
          sourceId: "source-a#chunk-1",
          text: "叫我 Mason"
        },
        {
          sourceId: "source-b#chunk-1",
          text: "就想叫你 Alice"
        }
      ],
      workspaceSlug: "demo",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage(params) {
          calls.push({ userContent: String(params.messages[0]?.content ?? "") });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                shouldExtract: true,
                candidates: [{
                  sourceId: "source-b#chunk-1",
                  kind: "preference",
                  targetScope: "global",
                  statement: "用户希望用 Alice 称呼助手",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "就想叫你 Alice",
                  reason: "User gave the assistant a preferred name.",
                  tags: ["profile"],
                  claim: {
                    subject: "assistant/self",
                    predicate: "preferred_name",
                    object: "Alice"
                  }
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
    expect(calls[0]?.userContent).toContain("source-a#chunk-1");
    expect(calls[0]?.userContent).toContain("source-b#chunk-1");
    expect(candidates).toEqual([
      {
        sourceId: "source-b#chunk-1",
        candidate: expect.objectContaining({
          statement: "用户希望用 Alice 称呼助手",
          evidence: expect.objectContaining({
            quote: "就想叫你 Alice"
          })
        })
      },
      {
        sourceId: "source-a#chunk-1",
        candidate: expect.objectContaining({
          statement: "用户希望被称呼为 Mason",
          claim: {
            subject: "user/self",
            predicate: "preferred_name",
            object: "Mason"
          }
        })
      }
    ]);
  });

  test("rechecks uncovered sources for up to the configured number of rounds", async () => {
    const calls: string[] = [];
    const candidates = await extractMemoryBatchCandidatesWithLlm({
      sources: [
        { sourceId: "source-a", text: "叫我 Mason" },
        { sourceId: "source-b", text: "我通常使用中文沟通" }
      ],
      modelRef: "openai/gpt-5-mini",
      maxRounds: 5,
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage(params) {
          const prompt = String(params.messages.at(-1)?.content ?? "");
          calls.push(prompt);
          const isReview = calls.length > 1;
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                shouldExtract: true,
                candidates: [isReview ? {
                  sourceId: "source-b",
                  kind: "preference",
                  targetScope: "global",
                  statement: "用户偏好默认用中文回答",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "我通常使用中文沟通",
                  reason: "User stated a durable language preference."
                } : {
                  sourceId: "source-a",
                  kind: "preference",
                  targetScope: "global",
                  statement: "用户希望被称呼为 Mason",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "叫我 Mason",
                  reason: "User gave a preferred name."
                }]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("source-b");
    expect(candidates.map((item) => item.sourceId)).toEqual(["source-a", "source-b"]);
  });

  test("runs the background extractor as a restricted memory tool agent", async () => {
    const toolSets: string[][] = [];
    let calls = 0;
    const candidates = await extractMemoryBatchCandidatesWithLlm({
      sources: [{ sourceId: "source-a", text: "我通常使用中文沟通" }],
      workspaceSlug: "demo",
      modelRef: "openai/gpt-5-mini",
      agentMode: true,
      threadId: "thread-memory-agent",
      runId: "run-memory-agent",
      maxRounds: 5,
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage(params) {
          calls += 1;
          toolSets.push((params.tools ?? []).map((tool) => tool.name));
          if (calls === 1) {
            return {
              content: [{
                type: "tool_use",
                id: "memory-search-1",
                name: "memory.search",
                input: { query: "中文偏好", maxResults: 3 }
              }],
              stopReason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 }
            };
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                shouldExtract: true,
                candidates: [{
                  sourceId: "source-a",
                  kind: "preference",
                  targetScope: "global",
                  statement: "用户偏好使用中文沟通",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "我通常使用中文沟通",
                  reason: "User stated a durable language preference."
                }]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(calls).toBe(2);
    expect(toolSets[0]).toEqual(["memory.search", "memory.read"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.candidate.statement).toBe("用户偏好使用中文沟通");
  });

  test("rejects batch candidates that cite the wrong source text", async () => {
    const candidates = await extractMemoryBatchCandidatesWithLlm({
      sources: [{
        sourceId: "source-a#chunk-1",
        text: "今天随便聊两句。"
      }],
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
                  sourceId: "source-a#chunk-1",
                  kind: "preference",
                  targetScope: "global",
                  statement: "用户希望用 Alice 称呼助手",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "就想叫你 Alice",
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

  test("accepts verified tool-result evidence but rejects assistant-only evidence", async () => {
    const candidates = await extractMemoryBatchCandidatesWithLlm({
      sources: [
        {
          sourceId: "tool-result-1",
          role: "tool_result",
          text: "Repository policy: Markdown remains the source of truth."
        },
        {
          sourceId: "assistant-1",
          role: "assistant",
          text: "The user prefers Markdown for all projects."
        }
      ],
      modelRef: "openai/gpt-5-mini",
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage() {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                shouldExtract: true,
                candidates: [
                  {
                  sourceId: "tool-result-1",
                  kind: "decision",
                  targetScope: "workspace",
                  statement: "项目使用 Markdown 作为事实源",
                  confidence: "high",
                  sourceRole: "tool_result",
                  sourceText: "Markdown remains the source of truth",
                  reason: "Verified project evidence."
                  },
                  {
                    sourceId: "assistant-1",
                    kind: "decision",
                    targetScope: "workspace",
                    statement: "项目使用 Markdown 作为事实源",
                    confidence: "high",
                    sourceRole: "assistant",
                    sourceText: "The user prefers Markdown for all projects.",
                    reason: "Assistant-only inference."
                  }
                ]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceId).toBe("tool-result-1");
  });

  test("keeps explicit batch memory intent when the LLM gate misses it", async () => {
    const candidates = await extractMemoryBatchCandidatesWithLlm({
      sources: [{
        sourceId: "source-a#chunk-1",
        text: "叫我 Mason"
      }],
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

    expect(candidates).toEqual([{
      sourceId: "source-a#chunk-1",
      candidate: expect.objectContaining({
        statement: "用户希望被称呼为 Mason",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      })
    }]);
  });

  test("keeps explicit batch memory intent from the same source when the LLM extracts a different claim", async () => {
    const candidates = await extractMemoryBatchCandidatesWithLlm({
      sources: [{
        sourceId: "source-a#chunk-1",
        text: "就想叫你 Alice"
      }],
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
                  sourceId: "source-a#chunk-1",
                  kind: "preference",
                  targetScope: "global",
                  statement: "用户偏好温暖直接的回应风格",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "就想叫你 Alice",
                  reason: "The model extracted a different durable preference.",
                  claim: {
                    subject: "user/self",
                    predicate: "preference",
                    object: "温暖直接的回应风格"
                  }
                }]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(candidates).toEqual([
      {
        sourceId: "source-a#chunk-1",
        candidate: expect.objectContaining({
          statement: "用户偏好温暖直接的回应风格",
          claim: {
            subject: "user/self",
            predicate: "preference",
            object: "温暖直接的回应风格"
          }
        })
      },
      {
        sourceId: "source-a#chunk-1",
        candidate: expect.objectContaining({
          statement: "用户希望用 Alice 称呼助手",
          claim: {
            subject: "assistant/self",
            predicate: "preferred_name",
            object: "Alice"
          }
        })
      }
    ]);
  });

  test("does not duplicate the same explicit batch claim when the LLM already extracted it", async () => {
    const candidates = await extractMemoryBatchCandidatesWithLlm({
      sources: [{
        sourceId: "source-a#chunk-1",
        text: "就想叫你 Alice"
      }],
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
                  sourceId: "source-a#chunk-1",
                  kind: "preference",
                  targetScope: "global",
                  statement: "用户希望用 Alice 称呼助手",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "就想叫你 Alice",
                  reason: "User gave the assistant a preferred name.",
                  tags: ["profile"],
                  claim: {
                    subject: "assistant/self",
                    predicate: "preferred_name",
                    object: "Alice"
                  }
                }]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      sourceId: "source-a#chunk-1",
      candidate: expect.objectContaining({
        statement: "用户希望用 Alice 称呼助手"
      })
    });
  });

  test("keeps explicit memory intent when the LLM gate misses it", async () => {
    const candidates = await extractMemoryCandidatesWithLlm({
      text: "叫我 Mason",
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

    expect(candidates).toEqual([expect.objectContaining({
      statement: "用户希望被称呼为 Mason",
      claim: {
        subject: "user/self",
        predicate: "preferred_name",
        object: "Mason"
      }
    })]);
  });

  test("trusts the LLM gate for non-explicit messages", async () => {
    const candidates = await extractMemoryCandidatesWithLlm({
      text: "今天随便聊两句。",
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
      text: "今天随便聊两句。",
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

  test("tries fallback memory models when the primary LLM extraction model fails", async () => {
    const models: string[] = [];
    const candidates = await extractMemoryCandidatesWithLlm({
      text: "以后默认用中文回答",
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
              text: JSON.stringify({
                shouldExtract: true,
                candidates: [{
                  kind: "preference",
                  targetScope: "global",
                  statement: "用户偏好默认用中文回答",
                  confidence: "high",
                  sourceRole: "user",
                  sourceText: "以后默认用中文回答",
                  reason: "User stated a durable language preference."
                }]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(models).toEqual(["broken-small", "qwen2.5:7b"]);
    expect(candidates[0]).toMatchObject({
      statement: "用户偏好默认用中文回答"
    });
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
