import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getWorkspaceResourcesPath } from "../infra/config-paths";
import { createAgentWorkspace } from "../agent/agent-workspace-manager";
import { listEntries } from "./markdown-store";
import {
  ingestExternalMemorySources,
  ingestMemorySources,
} from "./ingestion";
import type { MemoryV2Candidate } from "./types";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-v2-ingest-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("ingestMemorySources", () => {
  test("extracts durable claims from pasted text sources", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });

    const result = await ingestMemorySources({
      workspaceSlug: "demo",
      sources: [{
        id: "paste-1",
        kind: "pasted_text",
        title: "称呼偏好",
        content: "叫我 Mason",
        sourceRef: "pasted://paste-1",
        targetScope: "global"
      }]
    });

    expect(result.scannedSources).toBe(1);
    expect(result.scannedChunks).toBe(1);
    expect(result.candidateCount).toBe(1);
    expect(result.actions.new).toBe(1);
    expect(result.items).toEqual([expect.objectContaining({
      sourcePath: "pasted://paste-1#chunk-1",
      statement: "用户希望被称呼为 Mason",
      action: "new"
    })]);
    expect(listEntries({ workspaceSlug: "demo", scopes: ["global"] })).toEqual([
      expect.objectContaining({
        statement: "用户希望被称呼为 Mason",
        frontmatter: expect.objectContaining({
          claim: {
            subject: "user/self",
            predicate: "preferred_name",
            object: "Mason"
          },
          source: expect.objectContaining({
            path: "pasted://paste-1#chunk-1"
          })
        })
      })
    ]);
  });

  test("writes multiple explicit memories from one pasted text source", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });

    const result = await ingestMemorySources({
      workspaceSlug: "demo",
      sources: [{
        id: "paste-1",
        kind: "pasted_text",
        title: "多条偏好",
        content: "叫我 Mason。以后默认用中文回答",
        sourceRef: "pasted://paste-1",
        targetScope: "global"
      }]
    });

    expect(result.candidateCount).toBe(2);
    expect(result.actions.new).toBe(2);
    expect(result.items.map((item) => item.statement)).toEqual([
      "用户希望被称呼为 Mason",
      "默认用中文回答"
    ]);
    expect(listEntries({ workspaceSlug: "demo", scopes: ["global"] }).map((entry) => entry.statement)).toEqual([
      "默认用中文回答",
      "用户希望被称呼为 Mason"
    ]);
  });

  test("skips duplicate claims from repeated sources", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const source = {
      id: "paste-1",
      kind: "pasted_text" as const,
      title: "Assistant name",
      content: "就想叫你 Alice",
      sourceRef: "pasted://paste-1",
      targetScope: "global" as const
    };

    await ingestMemorySources({ workspaceSlug: "demo", sources: [source] });
    const result = await ingestMemorySources({ workspaceSlug: "demo", sources: [source] });

    expect(result.actions.duplicate).toBe(1);
    expect(listEntries({ workspaceSlug: "demo", scopes: ["global"] })).toHaveLength(1);
  });

  test("analyzes multiple chunks in one batch when the batch budget allows it", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const calls: string[][] = [];

    const result = await ingestMemorySources({
      workspaceSlug: "demo",
      batchMaxChars: 1000,
      sources: [
        {
          id: "paste-1",
          kind: "pasted_text",
          title: "User name",
          content: "叫我 Mason",
          sourceRef: "pasted://paste-1",
          targetScope: "global"
        },
        {
          id: "paste-2",
          kind: "pasted_text",
          title: "Assistant name",
          content: "就想叫你 Alice",
          sourceRef: "pasted://paste-2",
          targetScope: "global"
        }
      ],
      extractBatchCandidates: async ({ chunks }) => {
        calls.push(chunks.map((chunk) => chunk.sourcePath));
        return chunks.map((chunk) => ({
          sourceId: chunk.id,
          candidate: explicitCandidateForText(chunk.text)
        }));
      }
    });

    expect(calls).toEqual([[
      "pasted://paste-1#chunk-1",
      "pasted://paste-2#chunk-1"
    ]]);
    expect(result.scannedSources).toBe(2);
    expect(result.scannedChunks).toBe(2);
    expect(result.scannedBatches).toBe(1);
    expect(result.candidateCount).toBe(2);
    expect(result.actions.new).toBe(2);
  });

  test("splits ingestion analysis when the batch budget is exceeded", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const calls: string[][] = [];
    const progressEvents: Array<{
      scannedBatches: number;
      processedBatches: number;
      candidateCount: number;
    }> = [];

    const result = await ingestMemorySources({
      workspaceSlug: "demo",
      batchMaxChars: 8,
      sources: [
        {
          id: "paste-1",
          kind: "pasted_text",
          title: "User name",
          content: "叫我 Mason",
          sourceRef: "pasted://paste-1",
          targetScope: "global"
        },
        {
          id: "paste-2",
          kind: "pasted_text",
          title: "Assistant name",
          content: "就想叫你 Alice",
          sourceRef: "pasted://paste-2",
          targetScope: "global"
        }
      ],
      onProgress: (progress) => {
        progressEvents.push({
          scannedBatches: progress.scannedBatches,
          processedBatches: progress.processedBatches,
          candidateCount: progress.candidateCount
        });
      },
      extractBatchCandidates: async ({ chunks }) => {
        calls.push(chunks.map((chunk) => chunk.sourcePath));
        return chunks.map((chunk) => ({
          sourceId: chunk.id,
          candidate: explicitCandidateForText(chunk.text)
        }));
      }
    });

    expect(calls).toEqual([
      ["pasted://paste-1#chunk-1"],
      ["pasted://paste-2#chunk-1"]
    ]);
    expect(result.scannedBatches).toBe(2);
    expect(result.candidateCount).toBe(2);
    expect(progressEvents).toEqual([
      { scannedBatches: 2, processedBatches: 0, candidateCount: 0 },
      { scannedBatches: 2, processedBatches: 1, candidateCount: 1 },
      { scannedBatches: 2, processedBatches: 2, candidateCount: 2 }
    ]);
  });

  test("reports analyzed chunks that do not produce durable memory candidates", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });

    const result = await ingestMemorySources({
      workspaceSlug: "demo",
      sources: [{
        id: "paste-1",
        kind: "pasted_text",
        title: "普通文本",
        content: "这只是一段临时聊天内容，没有需要长期记住的事实。",
        sourceRef: "pasted://paste-1"
      }],
      extractBatchCandidates: async () => []
    });

    expect(result.scannedSources).toBe(1);
    expect(result.scannedChunks).toBe(1);
    expect(result.candidateCount).toBe(0);
    expect(result.actions.suppressed).toBe(1);
    expect(result.items).toEqual([expect.objectContaining({
      sourcePath: "pasted://paste-1#chunk-1",
      statement: "普通文本",
      action: "suppressed",
      reason: "No durable memory candidates found."
    })]);
  });
});

describe("ingestExternalMemorySources", () => {
  test("accumulates scanned source counts across mixed external inputs", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const filePath = join(root, "external-notes", "assistant-name.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "就想叫你 Alice", "utf-8");

    const result = await ingestExternalMemorySources({
      workspaceSlug: "demo",
      sources: [
        {
          kind: "pasted_text",
          content: "叫我 Mason",
          targetScope: "global"
        },
        {
          kind: "local_file",
          path: filePath,
          targetScope: "global"
        }
      ]
    });

    expect(result.scannedSources).toBe(2);
    expect(result.scannedChunks).toBe(2);
    expect(result.scannedBatches).toBe(1);
    expect(result.candidateCount).toBe(2);
    expect(result.actions.new).toBe(2);
  });
});

function explicitCandidateForText(text: string): MemoryV2Candidate {
  if (text.includes("Alice")) {
    return {
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
    };
  }
  return {
    kind: "preference",
    targetScope: "global",
    statement: "用户希望被称呼为 Mason",
    confidence: "high",
    tags: ["profile", "identity", "preferred-name"],
    claim: {
      subject: "user/self",
      predicate: "preferred_name",
      object: "Mason"
    }
  };
}
