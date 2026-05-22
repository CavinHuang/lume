import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { smartAddMemoryV2Candidate } from "./smart-add";
import { searchMemoryV2 } from "./retrieval";
import { createMemoryV2Store } from "./markdown-store";

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
    smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Memory V2 architecture keeps Markdown as truth and index data rebuildable.",
        confidence: "high",
        tags: ["architecture"]
      }
    });
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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

  test("recalls assistant preferred-name claim for assistant identity questions before history", async () => {
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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

  test("recalls user preferred-name claim for user identity questions", async () => {
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
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
    smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Memory architecture uses lexical fallback.",
        confidence: "high",
        tags: ["architecture"]
      }
    });
    smartAddMemoryV2Candidate({
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
      rerankItems: async (items) => [...items].sort((a, b) => (
        a.statement.includes("semantic") ? -1 : b.statement.includes("semantic") ? 1 : 0
      ))
    });

    expect(results[0]?.statement).toBe("Memory architecture uses semantic reranking.");
  });
});
