import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendDaily, appendRunArchive, createMemoryV2Store } from "./markdown-store";
import { getMemoryV2SettingsSnapshot } from "./settings-snapshot";
import { smartAddMemoryV2Candidate } from "./smart-add";
import { updateMemoryRuntimeConfig } from "./policy";

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
  test("summarizes files, entries, and pending review counts from Memory V2 markdown", () => {
    const store = createMemoryV2Store();
    store.ensureMemoryFile("workspace", "demo");
    store.ensureMemoryFile("global");
    store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "User prefers concise engineering updates.",
      confidence: "high"
    }, { pinned: true });
    smartAddMemoryV2Candidate({
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
      status: "not_configured"
    });
    expect(snapshot.retrieval.rerank.source).toBe("disabled");
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

  test("skips malformed pending files instead of failing the settings page", () => {
    const store = createMemoryV2Store();
    const memoryFile = store.ensureMemoryFile("workspace", "demo");
    writeFileSync(join(root, "agent-workspaces", "demo", "memory", "pending", "conflicts", "broken.md"), "not yaml", "utf-8");

    const snapshot = getMemoryV2SettingsSnapshot("demo");

    expect(snapshot.files.some((file) => file.path === memoryFile)).toBe(true);
    expect(snapshot.pending).toEqual([]);
  });
});
