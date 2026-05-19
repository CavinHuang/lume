import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { smartAddMemoryV2Candidate } from "./smart-add";
import { searchMemoryV2 } from "./retrieval";

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
});
