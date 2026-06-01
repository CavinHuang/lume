import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF } from "@lume/shared";
import { appendDaily, appendRunArchive, createMemoryV2Store } from "./markdown-store";
import { getMemoryV2SettingsSnapshot } from "./settings-snapshot";
import { smartAddMemoryV2Candidate } from "./smart-add";
import { updateMemoryRuntimeConfig } from "./policy";
import { updateLumeConfigSection } from "../system/lume-config-service";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-v2-settings-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("memory-v2 settings snapshot", () => {
  test("summarizes files, entries, and pending review counts from Memory V2 markdown", async () => {
    const store = createMemoryV2Store();
    store.ensureMemoryFile("workspace", "demo");
    store.ensureMemoryFile("global");
    store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "User prefers concise engineering updates.",
      confidence: "high"
    }, { pinned: true });
    await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "fact",
        targetScope: "workspace",
        statement: "Maybe this workspace uses weekly release notes.",
        confidence: "low"
      }
    });
    appendDaily({
      scope: "workspace",
      workspaceSlug: "demo",
      heading: "Run completed",
      body: "Updated memory settings UI."
    });
    appendRunArchive({
      workspaceSlug: "demo",
      runId: "run-1",
      record: { type: "run.completed" }
    });

    const snapshot = getMemoryV2SettingsSnapshot("demo");

    expect(snapshot.counts.global).toBe(1);
    expect(snapshot.counts.workspace).toBe(0);
    expect(snapshot.counts.pinned).toBe(1);
    expect(snapshot.counts.pending.lowConfidence).toBe(1);
    expect(snapshot.counts.pending.total).toBe(1);
    expect(snapshot.counts.daily).toBe(1);
    expect(snapshot.counts.runs).toBe(1);
    expect(snapshot.globalEntries[0]).toMatchObject({
      kind: "preference",
      scope: "global",
      pinned: true
    });
    expect(snapshot.pending[0]).toMatchObject({
      type: "low-confidence",
      status: "open"
    });
    expect(snapshot.files.map((file) => file.kind)).toEqual(expect.arrayContaining(["memory", "daily", "run"]));
    expect(snapshot.retrieval.semantic).toMatchObject({
      mode: "auto",
      status: "stale",
      embeddingModelRef: MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
      localOnnx: {
        modelRef: MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
        status: "not_cached"
      }
    });
    expect(snapshot.retrieval.semantic.fallbackModelRef).toBeUndefined();
    expect(snapshot.retrieval.semantic.localOnnx?.message).toContain("首次使用");
    expect(snapshot.retrieval.rerank.source).toBe("disabled");
  });

  test("reports cached local ONNX model files in the memory settings snapshot", () => {
    const modelDir = join(root, "memory", "models", "Xenova", "bge-small-zh-v1.5", "onnx");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "model_quantized.onnx"), "cached", "utf-8");

    const snapshot = getMemoryV2SettingsSnapshot("demo");

    expect(snapshot.retrieval.semantic.localOnnx).toMatchObject({
      status: "cached",
      cacheDir: join(root, "memory", "models")
    });
    expect(snapshot.retrieval.semantic.localOnnx?.message).toContain("已缓存");
  });

  test("reports semantic recall as disabled when configured off", () => {
    updateMemoryRuntimeConfig({
      retrieval: {
        semantic: "off",
        rerankModelRef: "openai/gpt-5-mini"
      }
    });

    const snapshot = getMemoryV2SettingsSnapshot("demo");

    expect(snapshot.retrieval.semantic).toMatchObject({
      mode: "off",
      status: "disabled"
    });
    expect(snapshot.retrieval.rerank).toEqual({
      modelRef: "openai/gpt-5-mini",
      source: "explicit"
    });
  });

  test("reports whether LLM memory extraction is configured", () => {
    expect(getMemoryV2SettingsSnapshot("demo").extraction).toEqual({
      source: "disabled",
      message: "未配置记忆提取模型；外部资料只会使用显式记忆句式。"
    });

    updateLumeConfigSection({
      source: "system",
      path: "memory.extraction.modelRef",
      value: "openai/gpt-5-mini"
    });

    expect(getMemoryV2SettingsSnapshot("demo").extraction).toEqual({
      modelRef: "openai/gpt-5-mini",
      source: "configured",
      message: "已配置记忆提取模型，外部资料会优先使用 LLM 分析。"
    });
  });

  test("skips malformed pending files instead of failing the settings page", () => {
    const store = createMemoryV2Store();
    const memoryFile = store.ensureMemoryFile("workspace", "demo");
    writeFileSync(join(root, "agent-workspaces", "demo", "memory", "pending", "conflicts", "broken.md"), "not yaml", "utf-8");

    const snapshot = getMemoryV2SettingsSnapshot("demo");

    expect(snapshot.files.some((file) => file.path === memoryFile)).toBe(true);
    expect(snapshot.pending).toEqual([]);
  });

  test("includes pending candidates and existing entry summaries for manual conflict review", () => {
    const store = createMemoryV2Store();
    const existing = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "用户希望被称呼为 Mason",
      confidence: "high",
      tags: ["profile"],
      claim: {
        subject: "user/self",
        predicate: "preferred_name",
        object: "Mason"
      }
    });
    store.writePending({
      type: "conflict",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Alice",
        confidence: "medium",
        tags: ["profile", "manual-review"],
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      },
      existingIds: [existing.frontmatter.id],
      reason: "称呼偏好变化"
    });

    const snapshot = getMemoryV2SettingsSnapshot("demo");

    expect(snapshot.pending[0]).toMatchObject({
      candidate: {
        statement: "用户希望被称呼为 Alice",
        kind: "preference",
        scope: "global",
        confidence: "medium",
        tags: ["profile", "manual-review"],
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      },
      existingEntries: [{
        id: existing.frontmatter.id,
        statement: "用户希望被称呼为 Mason",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      }]
    });
  });
});
