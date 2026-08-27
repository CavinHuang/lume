import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { smartAddMemoryV2Candidate } from "./smart-add";
import { searchMemoryV2 } from "./retrieval";
import { createMemoryV2Store, writeMarkdownDocument } from "./markdown-store";
import { DEFAULT_ACTIVATION } from "./types";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-v2-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("searchMemoryV2", () => {
  test("boosts decision memories for architecture queries", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Memory V2 architecture keeps Markdown as truth and index data rebuildable.",
        confidence: "high",
        tags: ["architecture"]
      }
    });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "User prefers short final summaries.",
        confidence: "high"
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "memory architecture design",
      maxResults: 3
    });

    expect(results[0]).toMatchObject({
      kind: "decision",
      scope: "workspace"
    });
  });

  test("recalls preferred-name memories for Chinese name questions", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "User wants to be called Mason.",
        confidence: "high",
        tags: ["preferred-name"]
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "我叫什么名字？",
      maxResults: 3
    });

    expect(results[0]).toMatchObject({
      kind: "preference",
      scope: "global",
      statement: "User wants to be called Mason."
    });
  });

  test("uses query planning to recall structured preference claims beyond keyword rules", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "User wants final reports to mention changed files and remaining risks.",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preference",
          object: "Final reports include changed files and remaining risks."
        }
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "收尾报告应该怎么写？",
      maxResults: 3,
      semantic: "off",
      queryPlanner: async () => ({
        querySubject: "user/self",
        desiredPredicates: ["preference"],
        includeConversationHistory: false
      })
    });

    expect(results[0]).toMatchObject({
      statement: "User wants final reports to mention changed files and remaining risks.",
      claim: {
        subject: "user/self",
        predicate: "preference"
      }
    });
  });

  test("recalls writing-style claims before unrelated preference memories", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户写作风格偏好简洁、有温度",
        confidence: "high",
        tags: ["voice", "writing-style"],
        claim: {
          subject: "user/self",
          predicate: "writing_style",
          object: "简洁、有温度"
        }
      }
    });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户偏好默认用中文回答",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preference",
          object: "默认用中文回答"
        }
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "我的文风应该是什么样？",
      maxResults: 3,
      semantic: "off"
    });

    expect(results[0]).toMatchObject({
      statement: "用户写作风格偏好简洁、有温度",
      claim: {
        subject: "user/self",
        predicate: "writing_style"
      }
    });
  });

  test("recalls assistant preferred-name claim for assistant identity questions before history", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Mason",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      }
    });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望用 Alice 称呼助手",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"],
        claim: {
          subject: "assistant/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      }
    });
    createMemoryV2Store().appendRunArchive({
      workspaceSlug: "demo",
      runId: "identity-noise",
      record: {
        userMessage: "你是谁？",
        assistantMessage: "我是 Lume。",
        threadId: "thread-secret",
        modelId: "glm-4.5"
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "你是谁？",
      maxResults: 4,
      semantic: "off"
    });

    expect(results[0]).toMatchObject({
      statement: "用户希望用 Alice 称呼助手",
      claim: {
        subject: "assistant/self",
        predicate: "preferred_name",
        object: "Alice"
      }
    });
    expect(results.some((item) => item.claim?.subject === "user/self")).toBe(false);
    expect(results.find((item) => item.reason.includes("run"))?.score ?? 0).toBeLessThan(results[0]!.score);
  });

  test("does not let semantic recall reintroduce claims for the wrong subject", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Mason",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      }
    });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望用 Alice 称呼助手",
        confidence: "high",
        claim: {
          subject: "assistant/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "你叫什么？",
      maxResults: 4,
      semantic: "auto",
      embedTexts: async (texts) => texts.map(() => [1, 0])
    });

    expect(results[0]?.claim).toMatchObject({
      subject: "assistant/self",
      predicate: "preferred_name",
      object: "Alice"
    });
    expect(results.some((item) => item.claim?.subject === "user/self")).toBe(false);
  });

  test("tries local ONNX semantic recall when the remote embedding attempt fails", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "fact",
        targetScope: "workspace",
        statement: "这两天一起写的文章主题是飞鸟与鱼。",
        confidence: "high"
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "最近写了什么文章？",
      maxResults: 3,
      semantic: "auto",
      embeddingAttempts: [
        {
          modelKey: "remote/broken",
          embedTexts: async () => {
            throw new Error("remote embedding down");
          }
        },
        {
          modelKey: "local-onnx/test",
          embedTexts: async (texts) => texts.map((text) => (
            text.includes("文章") ? [1, 0] : [0, 1]
          ))
        }
      ]
    });

    expect(results[0]).toMatchObject({
      statement: "这两天一起写的文章主题是飞鸟与鱼。"
    });
    expect(results[0]?.reason).toContain("semantic match");
  });

  test("recalls recent work history for current-state questions without semantic search", async () => {
    const store = createMemoryV2Store();
    store.appendDaily({
      scope: "workspace",
      workspaceSlug: "demo",
      heading: "Run completed",
      body: "Current activity: 正在优化 Lume 记忆跨对话连续性。\nAssistant outcome: 已分析召回为空的原因，下一步默认开启 ONNX 语义搜索。"
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "你知道我们最近在干嘛吗？当前工作状态是什么？",
      maxResults: 3,
      semantic: "off"
    });

    expect(results[0]).toMatchObject({
      reason: "recent daily memory",
      statement: expect.stringContaining("记忆跨对话连续性")
    });
  });

  test("recalls user preferred-name claim for user identity questions", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Mason",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "我是谁？",
      maxResults: 3,
      semantic: "off"
    });

    expect(results[0]).toMatchObject({
      statement: "用户希望被称呼为 Mason",
      claim: {
        subject: "user/self",
        predicate: "preferred_name",
        object: "Mason"
      }
    });
  });

  test("recalls user preference claim for preference questions without mixing assistant claims", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户偏好默认用中文回答",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preference",
          object: "默认用中文回答"
        }
      }
    });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望用 Alice 称呼助手",
        confidence: "high",
        claim: {
          subject: "assistant/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      }
    });
    createMemoryV2Store().appendRunArchive({
      workspaceSlug: "demo",
      runId: "preference-noise",
      record: {
        userMessage: "我的默认回复偏好是什么？",
        assistantMessage: "可能是英文。",
        threadId: "thread-secret",
        modelId: "glm-4.5"
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "我的默认回复偏好是什么？",
      maxResults: 4,
      semantic: "off"
    });

    expect(results[0]).toMatchObject({
      statement: "用户偏好默认用中文回答",
      claim: {
        subject: "user/self",
        predicate: "preference",
        object: "默认用中文回答"
      }
    });
    expect(results.some((item) => item.claim?.subject === "assistant/self")).toBe(false);
    expect(results.find((item) => item.reason.includes("run"))?.score ?? 0).toBeLessThan(results[0]!.score);
  });

  test("recalls workspace preference claim for workspace-scoped preference questions", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "workspace",
        statement: "工作区偏好使用 Bun 作为测试运行器",
        confidence: "high",
        claim: {
          subject: "workspace/default",
          predicate: "preference",
          object: "使用 Bun 作为测试运行器"
        }
      }
    });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户偏好默认用中文回答",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preference",
          object: "默认用中文回答"
        }
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "这个工作区默认使用什么测试运行器？",
      maxResults: 4,
      semantic: "off"
    });

    expect(results[0]).toMatchObject({
      statement: "工作区偏好使用 Bun 作为测试运行器",
      claim: {
        subject: "workspace/default",
        predicate: "preference",
        object: "使用 Bun 作为测试运行器"
      }
    });
    expect(results.some((item) => item.claim?.subject === "user/self")).toBe(false);
  });

  test("recalls workspace source-of-truth claims before noisy run history", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "fact",
        targetScope: "workspace",
        statement: "Lume Memory V2 使用 Markdown 作为事实源",
        confidence: "high",
        claim: {
          subject: "workspace/default",
          predicate: "source_of_truth",
          object: "Markdown"
        }
      }
    });
    createMemoryV2Store().appendRunArchive({
      workspaceSlug: "demo",
      runId: "source-noise",
      record: {
        userMessage: "这个工作区记忆系统的事实源是什么？",
        assistantMessage: "可能是数据库。",
        threadId: "thread-secret",
        modelId: "glm-4.5"
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "这个工作区记忆系统的事实源是什么？",
      maxResults: 4,
      semantic: "off"
    });

    expect(results[0]).toMatchObject({
      statement: "Lume Memory V2 使用 Markdown 作为事实源",
      claim: {
        subject: "workspace/default",
        predicate: "source_of_truth",
        object: "Markdown"
      }
    });
    expect(results.find((item) => item.reason.includes("run"))?.score ?? 0).toBeLessThan(results[0]!.score);
  });

  test("uses semantic recall when embeddings are available", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Use a layered memory recall pipeline with profile, lexical, semantic, and rerank fallback.",
        confidence: "high",
        tags: ["memory-architecture"]
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "Alice style vector lookup",
      maxResults: 3,
      semantic: "auto",
      embedTexts: async (texts) => texts.map((text) => (
        /layered memory|vector lookup|semantic/i.test(text) ? [1, 0] : [0, 1]
      ))
    });

    expect(results[0]).toMatchObject({
      statement: "Use a layered memory recall pipeline with profile, lexical, semantic, and rerank fallback.",
      reason: expect.stringContaining("semantic")
    });
  });

  test("falls back to lexical recall when semantic recall fails", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Memory V2 architecture keeps Markdown as truth and index data rebuildable.",
        confidence: "high",
        tags: ["architecture"]
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "memory architecture",
      maxResults: 3,
      semantic: "auto",
      embedTexts: async () => {
        throw new Error("embedding unavailable");
      }
    });

    expect(results[0]).toMatchObject({
      statement: "Memory V2 architecture keeps Markdown as truth and index data rebuildable."
    });
  });

  test("reranks candidate order when a reranker is available", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Memory architecture uses lexical fallback.",
        confidence: "high",
        tags: ["architecture"]
      }
    });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Memory architecture uses semantic reranking.",
        confidence: "high",
        tags: ["architecture"]
      }
    });

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "memory architecture",
      maxResults: 2,
      semantic: "off",
      rerankItems: async (items) => [...items].sort((a, b) => (
        a.statement.includes("semantic") ? -1 : b.statement.includes("semantic") ? 1 : 0
      ))
    });

    expect(results[0]?.statement).toBe("Memory architecture uses semantic reranking.");
  });

  test("activation.recall=false 的条目不参与召回", async () => {
    const store = createMemoryV2Store();
    const active = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "recall-active preference for vanilla flavor",
      confidence: "high",
      tags: ["flavor"]
    });
    const suppressed = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "recall-suppressed preference for vanilla flavor",
      confidence: "high",
      tags: ["flavor"]
    });
    writeMarkdownDocument(suppressed.path, {
      ...suppressed.frontmatter,
      activation: { ...DEFAULT_ACTIVATION, recall: false }
    }, suppressed.statement);

    const results = await searchMemoryV2({
      query: "vanilla flavor preference",
      maxResults: 5,
      semantic: "off"
    });

    expect(results.some((item) => item.statement === active.statement)).toBe(true);
    expect(results.some((item) => item.statement === suppressed.statement)).toBe(false);
  });

  test("treats expired entries as stale without mutating the store during search", async () => {
    const store = createMemoryV2Store();
    const created = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "User wants to be called Alice.",
      confidence: "high",
      claim: {
        subject: "user/self",
        predicate: "preferred_name",
        object: "Alice"
      }
    });
    const expired = store.updateEntry({
      scope: "global",
      id: created.frontmatter.id,
      validTo: "2000-01-01T00:00:00.000Z",
      expectedRevision: created.frontmatter.revision
    });

    const results = await searchMemoryV2({
      store,
      query: "我叫什么名字？",
      maxResults: 5,
      semantic: "off"
    });

    expect(results[0]).toMatchObject({
      id: expired.frontmatter.id,
      status: "suspected_stale"
    });
    const persisted = store.listEntries({ scopes: ["global"], includeStatuses: ["active", "suspected_stale"] })
      .find((entry) => entry.frontmatter.id === expired.frontmatter.id);
    expect(persisted?.frontmatter.status).toBe("active");
    expect(persisted?.frontmatter.revision).toBe(expired.frontmatter.revision);
  });

  test("minScore filters candidates before rerank on every return path (#538)", async () => {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Memory V2 minScore gating keeps low-relevance recall out.",
        confidence: "high",
        tags: ["architecture"]
      }
    });

    // minScore 过滤发生在候选池阶段（rerank 覆写 score 为序号之前），
    // 因此用不可能达到的巨大阈值即可钉死「阈值作用于原始检索分」语义
    const impossible = Number.MAX_SAFE_INTEGER;

    const filtered = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "memory architecture design",
      maxResults: 5,
      semantic: "off",
      rerankItems: async (items) => items,
      minScore: impossible,
    });
    expect(filtered).toEqual([]);

    // reranker 抛错路径下过滤仍生效
    const fallback = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "memory architecture design",
      maxResults: 5,
      semantic: "off",
      rerankItems: async () => { throw new Error("rerank down"); },
      minScore: impossible,
    });
    expect(fallback).toEqual([]);

    // 缺省不过滤
    const unfiltered = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "memory architecture design",
      maxResults: 5,
      semantic: "off",
      rerankItems: async (items) => items,
    });
    expect(unfiltered.length).toBeGreaterThan(0);
  });
});

describe("overrides 门控与 rerank 序 (#521)", () => {
  async function seedNameClaim(statement: string, object: string): Promise<void> {
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement,
        confidence: "high",
        tags: ["preferred-name"],
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object
        }
      }
    });
  }

  // 抑制的正用例:纠正语境 + predicate 命中计划 + object 已不在 query
  test("overrides a claim whose object is absent from a corrective query(#521)", async () => {
    await seedNameClaim("User wants to be called Alice.", "Alice");

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "以后改为 Bob。我叫什么名字？",
      maxResults: 5,
      semantic: "off"
    });

    expect(results.some((item) => item.statement === "User wants to be called Alice.")).toBe(false);
  });

  test("keeps the claim when the planned predicates do not match it(#521)", async () => {
    await seedNameClaim("User wants to be called Alice.", "Alice");

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "实际上 instead 这个功能应该怎么配置？我叫什么名字？",
      maxResults: 5,
      semantic: "off",
      // 直传 queryPlan 钉住门控本身;走 queryPlanner 时其输出会与 fallback
      // 计划合并(并入含"名字"的宽泛谓词),属机制既有粒度局限
      queryPlan: {
        querySubject: "",
        desiredPredicates: ["configuration"],
        includeConversationHistory: false
      }
    });

    expect(results.some((item) => item.statement === "User wants to be called Alice.")).toBe(true);
  });

  test("keeps a claim when a correction targets an unrelated clause(#521)", async () => {
    await seedNameClaim("User wants to be called Alice.", "Alice");

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "实际上 instead 这个功能应该怎么配置？我叫什么名字？",
      maxResults: 5,
      semantic: "off"
    });

    expect(results.some((item) => item.statement === "User wants to be called Alice.")).toBe(true);
  });

  test("does not treat a bare replacement followed by another topic as a name correction(#521)", async () => {
    await seedNameClaim("User wants to be called Alice.", "Alice");

    for (const query of [
      "以后改为 Bob，配置这个功能。我叫什么名字？",
      "以后改为 Bob。配置这个功能。我叫什么名字？"
    ]) {
      const results = await searchMemoryV2({
        workspaceSlug: "demo",
        query,
        maxResults: 5,
        semantic: "off"
      });
      expect(results.some((item) => item.statement === "User wants to be called Alice.")).toBe(true);
    }
  });

  test("recognizes an English name correction containing a comma(#521)", async () => {
    await seedNameClaim("User wants to be called Alice.", "Alice");

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "Actually, call me Bob. What's my name?",
      maxResults: 5,
      semantic: "off"
    });

    expect(results.some((item) => item.statement === "User wants to be called Alice.")).toBe(false);
  });

  test("does not treat ordinary negation or discourse markers as corrections(#521)", async () => {
    await seedNameClaim("User wants to be called Alice.", "Alice");

    for (const query of [
      "我叫什么名字不是重点，配置这个功能应该怎么做？",
      "Actually, what's my name?",
      "Instead, what is my name?"
    ]) {
      const results = await searchMemoryV2({
        workspaceSlug: "demo",
        query,
        maxResults: 5,
        semantic: "off"
      });
      expect(results.some((item) => item.statement === "User wants to be called Alice.")).toBe(true);
    }
  });

  test("rerank order overrides legacy scores for final selection(#521)", async () => {
    for (const text of [
      "Filler memory entry zero about testing.",
      "Filler memory entry one about testing.",
      "Target memory entry the user explicitly cares about."
    ]) {
      await smartAddMemoryV2Candidate({
        workspaceSlug: "demo",
        candidate: {
          kind: "preference",
          targetScope: "global",
          statement: text,
          confidence: "high"
        }
      });
    }

    const results = await searchMemoryV2({
      workspaceSlug: "demo",
      query: "user explicitly cares",
      maxResults: 1,
      semantic: "off",
      rerankItems: async (items) => {
        const target = items.find((item) => item.statement.includes("explicitly cares"))!;
        return [target, ...items.filter((item) => item !== target)];
      }
    });

    expect(results[0]?.statement).toContain("explicitly cares");
  });
});
