import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryV2Store, listEntries } from "./markdown-store";
import { organizeMemoryEntries } from "./entry-organizer";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lume-memory-v2-entry-organize-"));
  process.env.LUME_CONFIG_DIR = root;
});

afterEach(() => {
  delete process.env.LUME_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("organizeMemoryEntries", () => {
  test("builds an LLM organize plan from the configured model provider", async () => {
    const store = createMemoryV2Store();
    const kept = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Lume stores durable memories in Markdown files.",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    const duplicate = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Markdown files are the canonical storage for durable Lume memories.",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    const calls: Array<{ system: string; userContent: string }> = [];

    const result = await organizeMemoryEntries({
      workspaceSlug: "demo",
      modelRef: "openai/gpt-5-mini",
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage(params) {
          calls.push({
            system: params.system,
            userContent: String(params.messages[0]?.content ?? "")
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                duplicates: [{
                  keepId: kept.frontmatter.id,
                  duplicateIds: [duplicate.frontmatter.id],
                  reason: "Same storage decision."
                }]
              })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(calls).toEqual([expect.objectContaining({
      system: expect.stringContaining("organize existing Lume memories"),
      userContent: expect.stringContaining(kept.frontmatter.id)
    })]);
    expect(result.supersededDuplicates).toBe(1);
    expect(result.items[0]).toMatchObject({
      keptId: kept.frontmatter.id,
      duplicateId: duplicate.frontmatter.id,
      reason: "Same storage decision."
    });
  });

  test("uses an LLM organize plan before local duplicate fallback", async () => {
    const store = createMemoryV2Store();
    const kept = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Lume stores durable memories in Markdown files.",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    const duplicate = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Markdown files are the canonical storage for durable Lume memories.",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    let planned = false;

    const result = await organizeMemoryEntries({
      workspaceSlug: "demo",
      planEntries: async (entries) => {
        planned = true;
        expect(entries.map((entry) => entry.id).sort()).toEqual([
          kept.frontmatter.id,
          duplicate.frontmatter.id
        ].sort());
        return [{
          keepId: kept.frontmatter.id,
          duplicateIds: [duplicate.frontmatter.id],
          reason: "Same storage decision."
        }];
      }
    });

    expect(planned).toBe(true);
    expect(result).toMatchObject({
      workspaceSlug: "demo",
      scannedEntries: 2,
      supersededDuplicates: 1,
      keptEntries: 1,
      items: [{
        keptId: kept.frontmatter.id,
        duplicateId: duplicate.frontmatter.id,
        reason: "Same storage decision."
      }]
    });
    expect(listEntries({ workspaceSlug: "demo", scopes: ["workspace"], includeStatuses: ["active"] })).toHaveLength(1);
  });

  test("applies only safe metadata updates through the command service", async () => {
    const store = createMemoryV2Store();
    const entry = store.writeEntry({
      kind: "fact",
      targetScope: "workspace",
      statement: "Lume memory uses verified tool evidence.",
      confidence: "medium",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    const result = await organizeMemoryEntries({
      workspaceSlug: "demo",
      planEntries: async () => [{
        keepId: entry.frontmatter.id,
        duplicateIds: ["missing-duplicate"],
        reason: "No duplicate found.",
        update: { confidence: "high", facets: ["verified", "tool-result"] }
      }]
    });

    expect(result.updated).toBe(1);
    const updated = listEntries({ workspaceSlug: "demo", scopes: ["workspace"], includeStatuses: ["active"] })[0]!;
    expect(updated.statement).toBe(entry.statement);
    expect(updated.frontmatter.confidence).toBe("high");
    expect(updated.frontmatter.facets).toEqual(["verified", "tool-result"]);
    expect(updated.frontmatter.revision).toBeGreaterThan(entry.frontmatter.revision);
  });

  test("splits LLM organizer input into batches", async () => {
    const store = createMemoryV2Store();
    for (const statement of [
      "Lume memory keeps project decisions in Markdown.",
      "Lume memory can import durable notes from local files.",
      "Lume memory cites recalled items below assistant messages."
    ]) {
      store.writeEntry({
        kind: "decision",
        targetScope: "workspace",
        statement,
        confidence: "high",
        tags: ["memory"],
        appliesWhen: { workspaceSlug: "demo" }
      });
    }
    const batchSizes: number[] = [];

    const result = await organizeMemoryEntries({
      workspaceSlug: "demo",
      modelRef: "openai/gpt-5-mini",
      organizeBatchSize: 2,
      createProvider: () => ({
        apiType: "openai-completions",
        async createMessage(params) {
          const payload = JSON.parse(String(params.messages[0]?.content ?? "{}")) as {
            entries?: unknown[];
          };
          batchSizes.push(payload.entries?.length ?? 0);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ duplicates: [] })
            }],
            stopReason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 }
          };
        }
      })
    });

    expect(batchSizes).toEqual([2, 1]);
    expect(result).toMatchObject({
      scannedEntries: 3,
      supersededDuplicates: 0,
      keptEntries: 3
    });
  });

  test("marks near-duplicate historical entries as superseded", async () => {
    const store = createMemoryV2Store();
    const kept = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Lume memory uses Markdown as the source of truth.",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    const duplicate = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Lume memory uses Markdown as source of truth",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });

    const result = await organizeMemoryEntries({ workspaceSlug: "demo" });

    expect(result).toMatchObject({
      workspaceSlug: "demo",
      scannedEntries: 2,
      supersededDuplicates: 1,
      keptEntries: 1,
      items: [expect.objectContaining({
        action: "superseded_duplicate"
      })]
    });
    const active = listEntries({ workspaceSlug: "demo", scopes: ["workspace"], includeStatuses: ["active"] });
    const superseded = listEntries({ workspaceSlug: "demo", scopes: ["workspace"], includeStatuses: ["superseded"] });
    expect(active).toHaveLength(1);
    expect(superseded).toEqual([
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          superseded_by: active[0]!.frontmatter.id
        })
      })
    ]);
    expect(new Set([active[0]!.frontmatter.id, superseded[0]!.frontmatter.id])).toEqual(new Set([
      kept.frontmatter.id,
      duplicate.frontmatter.id
    ]));
  });

  test("does not commit a planned merge after the persistent job is cancelled", async () => {
    const store = createMemoryV2Store();
    const kept = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Lume uses Markdown for memory storage.",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    const duplicate = store.writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Markdown is Lume's memory storage.",
      confidence: "high",
      tags: ["memory"],
      appliesWhen: { workspaceSlug: "demo" }
    });
    const controller = new AbortController();

    await expect(organizeMemoryEntries({
      workspaceSlug: "demo",
      signal: controller.signal,
      planEntries: async () => {
        controller.abort();
        return [{
          keepId: kept.frontmatter.id,
          duplicateIds: [duplicate.frontmatter.id],
          reason: "Same storage decision."
        }];
      }
    })).rejects.toThrow();

    expect(listEntries({ workspaceSlug: "demo", scopes: ["workspace"], includeStatuses: ["active"] })).toHaveLength(2);
  });
});
