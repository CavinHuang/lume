import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryV2EmbeddingAttempts,
  createMemoryV2EmbeddingProviderFromAttempts,
  LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF,
  resolveMemoryEmbeddingAttempts
} from "./embedding";

describe("memory-v2 embedding providers", () => {
  test("falls back to local ONNX embeddings when the configured remote provider fails", async () => {
    const calls: string[] = [];
    const embedTexts = createMemoryV2EmbeddingProviderFromAttempts([
      {
        modelKey: "openai/text-embedding-3-small",
        embedTexts: async () => {
          calls.push("remote");
          throw new Error("remote unavailable");
        }
      },
      {
        modelKey: LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF,
        embedTexts: async (texts) => {
          calls.push("local");
          return texts.map(() => [0, 1]);
        }
      }
    ]);

    await expect(embedTexts?.(["hello"])).resolves.toEqual([[0, 1]]);
    expect(calls).toEqual(["remote", "local"]);
  });

  test("uses local ONNX as the semantic attempt when no remote embedding model is configured", () => {
    const attempts = resolveMemoryEmbeddingAttempts({
      configuredModelRef: undefined,
      remote: undefined,
      local: async (texts) => texts.map(() => [1, 0])
    });

    expect(attempts.map((attempt) => attempt.modelKey)).toEqual([
      LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF
    ]);
  });

  test("uses only local ONNX when it is explicitly selected", () => {
    const attempts = resolveMemoryEmbeddingAttempts({
      configuredModelRef: LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF,
      remote: async (texts) => texts.map(() => [0, 1]),
      local: async (texts) => texts.map(() => [1, 0])
    });

    expect(attempts.map((attempt) => attempt.modelKey)).toEqual([
      LOCAL_ONNX_MEMORY_EMBEDDING_MODEL_REF
    ]);
  });

  test("does not start implicit local ONNX when callers disable local attempts", () => {
    const prevConfigDir = process.env.LUME_CONFIG_DIR;
    const configDir = mkdtempSync(join(tmpdir(), "lume-memory-embedding-test-"));
    process.env.LUME_CONFIG_DIR = configDir;
    try {
      const attempts = createMemoryV2EmbeddingAttempts("demo", {
        includeImplicitLocal: false
      });

      expect(attempts).toEqual([]);
    } finally {
      if (prevConfigDir === undefined) {
        delete process.env.LUME_CONFIG_DIR;
      } else {
        process.env.LUME_CONFIG_DIR = prevConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
