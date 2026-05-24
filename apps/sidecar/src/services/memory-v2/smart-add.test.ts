import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { smartAddMemoryV2Candidate } from "./smart-add";
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

describe("smartAddMemoryV2Candidate", () => {
  test("stores a new active memory and skips exact duplicates", async () => {
    const first = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Lume memory uses Markdown as the source of truth.",
        confidence: "high",
        tags: ["memory"]
      }
    });
    expect(first.action).toBe("new");
    expect(first.entry?.frontmatter.status).toBe("active");

    const second = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Lume memory uses Markdown as the source of truth.",
        confidence: "high",
        tags: ["memory"]
      }
    });
    expect(second.action).toBe("duplicate");
    expect(second.existingIds).toEqual([first.entry!.frontmatter.id]);
  });

  test("skips near-duplicate durable memories instead of appending another entry", async () => {
    const first = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Lume memory uses Markdown as the source of truth.",
        confidence: "high",
        tags: ["memory"]
      }
    });

    const second = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "decision",
        targetScope: "workspace",
        statement: "Lume memory uses Markdown as source of truth",
        confidence: "high",
        tags: ["memory"]
      }
    });

    expect(first.action).toBe("new");
    expect(second.action).toBe("duplicate");
    expect(second.existingIds).toEqual([first.entry!.frontmatter.id]);
  });

  test("uses embeddings to skip semantic near-duplicates when lexical overlap is weak", async () => {
    const first = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "Final reports must list changed files and remaining risks.",
        confidence: "high",
        tags: ["reporting"]
      },
      embedTexts: async (texts) => texts.map(() => [1, 0])
    });

    const second = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "Closing summaries should include touched files and leftover risk.",
        confidence: "high",
        tags: ["reporting"]
      },
      embedTexts: async (texts) => texts.map(() => [1, 0])
    });

    expect(first.action).toBe("new");
    expect(second.action).toBe("duplicate");
    expect(second.existingIds).toEqual([first.entry!.frontmatter.id]);
  });

  test("updates related entries when storing a new related memory", async () => {
    const first = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "fact",
        targetScope: "workspace",
        statement: "Lume memory stores Markdown entries as the source of truth.",
        confidence: "high",
        entities: ["memory-system"]
      }
    });
    const second = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "fact",
        targetScope: "workspace",
        statement: "Lume memory rebuilds vector indexes from Markdown entries.",
        confidence: "high",
        entities: ["memory-system"]
      }
    });

    expect(second.action).toBe("related");
    expect(second.entry?.frontmatter.related).toEqual([first.entry!.frontmatter.id]);
    const refreshedFirst = createMemoryV2Store()
      .listEntries({ workspaceSlug: "demo", scopes: ["workspace"], includeStatuses: ["active"] })
      .find((entry) => entry.frontmatter.id === first.entry!.frontmatter.id);
    expect(refreshedFirst?.frontmatter.related).toEqual([second.entry!.frontmatter.id]);
  });

  test("routes low-confidence candidates to pending", async () => {
    const result = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "fact",
        targetScope: "workspace",
        statement: "Maybe this project uses a custom release checklist.",
        confidence: "low"
      }
    });
    expect(result.action).toBe("low_confidence");
    expect(result.pending?.frontmatter.type).toBe("low-confidence");
  });

  test("marks related commute memory suspected stale when location changes", async () => {
    const first = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "fact",
        targetScope: "workspace",
        statement: "User's drive from Beijing home to office takes 15 minutes.",
        confidence: "high",
        entities: ["commute"]
      }
    });
    const second = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "fact",
        targetScope: "workspace",
        statement: "User recently moved to Tianjin.",
        confidence: "high",
        entities: ["commute"]
      }
    });
    expect(second.action).toBe("suspected_stale");
    expect(second.existingIds).toEqual([first.entry!.frontmatter.id]);
    expect(second.pending?.frontmatter.type).toBe("stale");
  });

  test("does not append duplicate preferred-name profile memories", async () => {
    const first = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Mason",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"]
      }
    });
    const second = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Mason",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"]
      }
    });

    expect(first.action).toBe("new");
    expect(second.action).toBe("duplicate");
    expect(second.existingIds).toEqual([first.entry!.frontmatter.id]);
  });

  test("uses claim key to skip duplicate preferred-name memories", async () => {
    const first = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被叫 Mason",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      }
    });
    const second = await smartAddMemoryV2Candidate({
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

    expect(first.action).toBe("new");
    expect(second.action).toBe("duplicate");
    expect(second.existingIds).toEqual([first.entry!.frontmatter.id]);
  });

  test("routes preferred-name changes to conflict review", async () => {
    const first = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Mason",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"]
      }
    });
    const second = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Cavin",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"]
      }
    });

    expect(second.action).toBe("conflict");
    expect(second.existingIds).toEqual([first.entry!.frontmatter.id]);
    expect(second.pending?.frontmatter.type).toBe("conflict");
  });

  test("routes same claim key with different object to conflict review", async () => {
    const first = await smartAddMemoryV2Candidate({
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
    const second = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Cavin",
        confidence: "high",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Cavin"
        }
      }
    });

    expect(first.action).toBe("new");
    expect(second.action).toBe("conflict");
    expect(second.existingIds).toEqual([first.entry!.frontmatter.id]);
    expect(second.pending?.frontmatter.type).toBe("conflict");
  });

  test("does not conflict assistant preferred name with user preferred name", async () => {
    const userName = await smartAddMemoryV2Candidate({
      workspaceSlug: "demo",
      candidate: {
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
      }
    });
    const assistantName = await smartAddMemoryV2Candidate({
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

    expect(userName.action).toBe("new");
    expect(assistantName.action).toBe("new");
  });
});
