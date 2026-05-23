import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getWorkspaceResourcesPath } from "../infra/config-paths";
import { createAgentWorkspace } from "../agent/agent-workspace-manager";
import { listEntries } from "./markdown-store";
import {
  ingestExternalMemorySources,
  ingestLocalMemoryFiles,
  ingestLocalMemoryFolders,
  ingestMemorySources,
  ingestWorkspaceMemoryFiles
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
  });
});

describe("ingestWorkspaceMemoryFiles", () => {
  test("reads supported workspace text files and preserves file evidence", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const resources = getWorkspaceResourcesPath("demo");
    const filePath = join(resources, "docs", "project.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "记住：Lume Memory V2 使用 Markdown 作为事实源", "utf-8");

    const result = await ingestWorkspaceMemoryFiles({
      workspaceSlug: "demo",
      paths: ["docs/project.md"]
    });

    expect(result.scannedSources).toBe(1);
    expect(result.scannedChunks).toBe(1);
    expect(result.candidateCount).toBe(1);
    expect(result.actions.new).toBe(1);
    expect(result.items[0]).toEqual(expect.objectContaining({
      sourcePath: "workspace://demo/docs/project.md#chunk-1",
      action: "new"
    }));
    expect(listEntries({ workspaceSlug: "demo", scopes: ["workspace"] })[0]).toEqual(
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          source: expect.objectContaining({
            path: "workspace://demo/docs/project.md#chunk-1"
          })
        })
      })
    );
  });

  test("reports unsupported workspace files without ingesting them", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const resources = getWorkspaceResourcesPath("demo");
    const filePath = join(resources, "slides", "deck.pdf");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "%PDF-1.7", "utf-8");

    const result = await ingestWorkspaceMemoryFiles({
      workspaceSlug: "demo",
      paths: ["slides/deck.pdf"]
    });

    expect(result.scannedSources).toBe(1);
    expect(result.scannedChunks).toBe(0);
    expect(result.candidateCount).toBe(0);
    expect(result.items).toEqual([expect.objectContaining({
      sourcePath: "workspace://demo/slides/deck.pdf",
      action: "suppressed",
      reason: "Unsupported workspace file type."
    })]);
    expect(listEntries({ workspaceSlug: "demo", scopes: ["workspace"] })).toHaveLength(0);
  });
});

describe("ingestLocalMemoryFiles", () => {
  test("reads supported local text files and preserves file evidence", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const filePath = join(root, "external-notes", "name.txt");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "叫我 Mason", "utf-8");

    const result = await ingestLocalMemoryFiles({
      workspaceSlug: "demo",
      paths: [filePath]
    });

    expect(result.scannedSources).toBe(1);
    expect(result.scannedChunks).toBe(1);
    expect(result.candidateCount).toBe(1);
    expect(result.actions.new).toBe(1);
    expect(result.items[0]).toEqual(expect.objectContaining({
      sourcePath: `file://${filePath}#chunk-1`,
      action: "new"
    }));
    expect(listEntries({ workspaceSlug: "demo", scopes: ["global"] })[0]).toEqual(
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          source: expect.objectContaining({
            path: `file://${filePath}#chunk-1`
          })
        })
      })
    );
  });

  test("reports unsupported local files without ingesting them", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const filePath = join(root, "external-notes", "deck.pdf");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "%PDF-1.7", "utf-8");

    const result = await ingestLocalMemoryFiles({
      workspaceSlug: "demo",
      paths: [filePath]
    });

    expect(result.scannedSources).toBe(1);
    expect(result.scannedChunks).toBe(0);
    expect(result.candidateCount).toBe(0);
    expect(result.items).toEqual([expect.objectContaining({
      sourcePath: `file://${filePath}`,
      action: "suppressed",
      reason: "Unsupported local file type."
    })]);
  });
});

describe("ingestLocalMemoryFolders", () => {
  test("recursively reads supported local text files in a selected folder", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const folderPath = join(root, "external-folder");
    const filePath = join(folderPath, "notes", "name.md");
    const ignoredPath = join(folderPath, "node_modules", "ignored.md");
    mkdirSync(dirname(filePath), { recursive: true });
    mkdirSync(dirname(ignoredPath), { recursive: true });
    writeFileSync(filePath, "叫我 Mason", "utf-8");
    writeFileSync(ignoredPath, "就想叫你 Ignored", "utf-8");
    writeFileSync(join(folderPath, "deck.pdf"), "%PDF-1.7", "utf-8");

    const result = await ingestLocalMemoryFolders({
      workspaceSlug: "demo",
      paths: [folderPath]
    });

    expect(result.scannedSources).toBe(1);
    expect(result.scannedChunks).toBe(1);
    expect(result.candidateCount).toBe(1);
    expect(result.actions.new).toBe(1);
    expect(result.items[0]).toEqual(expect.objectContaining({
      sourcePath: `file://${filePath}#chunk-1`,
      action: "new"
    }));
    expect(listEntries({ workspaceSlug: "demo", scopes: ["global"] })).toHaveLength(1);
  });

  test("reports selected folders with no supported text files", async () => {
    createAgentWorkspace("Demo", { slug: "demo" });
    const folderPath = join(root, "empty-folder");
    mkdirSync(folderPath, { recursive: true });
    writeFileSync(join(folderPath, "deck.pdf"), "%PDF-1.7", "utf-8");

    const result = await ingestLocalMemoryFolders({
      workspaceSlug: "demo",
      paths: [folderPath]
    });

    expect(result.scannedSources).toBe(1);
    expect(result.scannedChunks).toBe(0);
    expect(result.candidateCount).toBe(0);
    expect(result.items).toEqual([expect.objectContaining({
      sourcePath: `file://${folderPath}`,
      action: "suppressed",
      reason: "No supported local text files found."
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
