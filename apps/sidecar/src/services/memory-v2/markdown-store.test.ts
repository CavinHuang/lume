import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendDaily,
  appendRunArchive,
  createMemoryV2Store,
  deleteEntry,
  listEntries,
  readActivation,
  readEntryFile,
  readPendingFile,
  redactArchiveRecord,
  resolvePending,
  updateEntry,
  writeEntry
} from "./markdown-store";
import type { MemoryV2EntryFrontmatter } from "./types";
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

describe("memory-v2 markdown store", () => {
  test("round trips entry frontmatter and filters active entries", () => {
    const entry = writeEntry({
      kind: "decision",
      targetScope: "workspace",
      statement: "Memory V2 stores one claim per entry file.",
      confidence: "high",
      appliesWhen: { workspaceSlug: "demo" }
    });

    expect(existsSync(entry.path)).toBe(true);
    expect(readEntryFile(entry.path).frontmatter.id).toBe(entry.frontmatter.id);
    expect(listEntries({ workspaceSlug: "demo", includeStatuses: ["active"] })).toHaveLength(1);
  });

  test("appends daily notes and redacted run archive records", () => {
    const dailyPath = appendDaily({
      scope: "workspace",
      workspaceSlug: "demo",
      date: new Date("2026-05-19T00:00:00Z"),
      heading: "Run completed",
      body: "Implemented memory V2 storage."
    });
    expect(readFileSync(dailyPath, "utf-8")).toContain("Implemented memory V2 storage.");

    const archivePath = appendRunArchive({
      workspaceSlug: "demo",
      runId: "run-1",
      record: {
        type: "tool.result",
        apiKey: "sk-1234567890abcdefghijkl"
      }
    });
    const archive = readFileSync(archivePath, "utf-8");
    expect(archive).toContain("[REDACTED]");
    expect(archive).not.toContain("sk-1234567890abcdefghijkl");
  });

  test("redaction marks records that contained secrets", () => {
    expect(redactArchiveRecord({ token: "secret" })).toMatchObject({
      token: "[REDACTED]",
      redacted: true
    });
  });

  test("manually updates an entry statement and metadata", () => {
    const entry = writeEntry({
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

    const updated = updateEntry({
      scope: "global",
      id: entry.frontmatter.id,
      statement: "用户希望被称呼为 Alice",
      kind: "fact",
      confidence: "medium",
      tags: ["profile", "manual"]
    });

    expect(updated.statement).toBe("用户希望被称呼为 Alice");
    expect(updated.frontmatter.kind).toBe("fact");
    expect(updated.frontmatter.confidence).toBe("medium");
    expect(updated.frontmatter.tags).toEqual(["profile", "manual"]);
    expect(updated.frontmatter.claim).toMatchObject({
      subject: "user/self",
      predicate: "preferred_name",
      object: "Alice"
    });
    expect(readEntryFile(entry.path).statement).toBe("用户希望被称呼为 Alice");
    expect(readEntryFile(entry.path).frontmatter.claim).toMatchObject({
      subject: "user/self",
      predicate: "preferred_name",
      object: "Alice"
    });
  });

  test("manually deletes an entry and removes stale relations from neighbors", () => {
    const first = writeEntry({
      kind: "fact",
      targetScope: "workspace",
      statement: "第一条记忆",
      confidence: "high",
      appliesWhen: { workspaceSlug: "demo" }
    });
    const second = writeEntry({
      kind: "fact",
      targetScope: "workspace",
      statement: "第二条记忆",
      confidence: "high",
      appliesWhen: { workspaceSlug: "demo" }
    }, {
      related: [first.frontmatter.id],
      supersedes: [first.frontmatter.id]
    });
    updateEntryStatusForTest(first.frontmatter.id, second.frontmatter.id);

    const result = deleteEntry({
      scope: "workspace",
      workspaceSlug: "demo",
      id: first.frontmatter.id
    });

    expect(result).toEqual({ ok: true, id: first.frontmatter.id, path: first.path });
    expect(existsSync(first.path)).toBe(false);
    const refreshedSecond = readEntryFile(second.path);
    expect(refreshedSecond.frontmatter.related).toEqual([]);
    expect(refreshedSecond.frontmatter.supersedes).toEqual([]);
  });

  test("accepts a pending conflict into a real entry and supersedes existing entries", () => {
    const store = createMemoryV2Store();
    const existing = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "用户希望被称呼为 Mason",
      confidence: "high",
      claim: {
        subject: "user/self",
        predicate: "preferred_name",
        object: "Mason"
      }
    });
    const pending = store.writePending({
      type: "conflict",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Alice",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"],
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      },
      existingIds: [existing.frontmatter.id],
      reason: "同一称呼偏好发生变化"
    });

    const result = resolvePending({
      workspaceSlug: "demo",
      path: pending.path,
      action: "accept"
    });

    expect(result.ok).toBe(true);
    expect(result.entryId).toBeTruthy();
    const entryId = result.entryId;
    if (!entryId) throw new Error("pending accept did not create entry");
    const accepted = listEntries({ scopes: ["global"], includeStatuses: ["active"] })
      .find((entry) => entry.frontmatter.id === entryId);
    expect(accepted?.statement).toBe("用户希望被称呼为 Alice");
    expect(accepted?.frontmatter.claim?.object).toBe("Alice");
    expect(readEntryFile(existing.path).frontmatter.status).toBe("superseded");
    expect(readEntryFile(existing.path).frontmatter.superseded_by).toBe(entryId);
    expect(readPendingFile(pending.path).frontmatter.status).toBe("resolved");
  });

  test("accepts a pending conflict with a manual candidate override", () => {
    const store = createMemoryV2Store();
    const existing = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "用户希望被称呼为 Mason",
      confidence: "high"
    });
    const pending = store.writePending({
      type: "conflict",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Alice",
        confidence: "medium",
        tags: ["profile"]
      },
      existingIds: [existing.frontmatter.id],
      reason: "称呼偏好变化"
    });

    const result = resolvePending({
      workspaceSlug: "demo",
      path: pending.path,
      action: "accept",
      candidateOverride: {
        statement: "用户希望在产品演示时被称呼为 Alice",
        kind: "fact",
        confidence: "high",
        tags: ["profile", "demo"]
      }
    });

    const entryId = result.entryId;
    if (!entryId) throw new Error("pending accept did not create entry");
    const accepted = listEntries({ scopes: ["global"], includeStatuses: ["active"] })
      .find((entry) => entry.frontmatter.id === entryId);
    expect(accepted?.statement).toBe("用户希望在产品演示时被称呼为 Alice");
    expect(accepted?.frontmatter.kind).toBe("fact");
    expect(accepted?.frontmatter.confidence).toBe("high");
    expect(accepted?.frontmatter.tags).toEqual(["profile", "demo"]);
  });

  test("findEntryById 命中存在的 entry（updateEntryStatus 成功更新）", () => {
    const store = createMemoryV2Store();
    const entry = store.writeEntry({
      kind: "decision",
      targetScope: "global",
      statement: "Memory V2 stores one claim per entry file.",
      confidence: "high"
    });

    const updated = store.updateEntryStatus({
      scope: entry.frontmatter.scope,
      workspaceSlug: undefined,
      id: entry.frontmatter.id,
      status: "archived"
    });

    expect(updated.frontmatter.status).toBe("archived");
    expect(updated.frontmatter.id).toBe(entry.frontmatter.id);
    expect(readEntryFile(entry.path).frontmatter.status).toBe("archived");
  });

  test("findEntryById 未命中时抛错（不存在 id）", () => {
    const store = createMemoryV2Store();

    expect(() => store.updateEntryStatus({
      scope: "global",
      workspaceSlug: undefined,
      id: "nonexistent-id-xxx",
      status: "archived"
    })).toThrow(/not found/);
  });

  test("多个 entry 下 findEntryById 精确定位（无文件名后缀误匹配）", () => {
    const store = createMemoryV2Store();
    const a = store.writeEntry({
      kind: "fact",
      targetScope: "global",
      statement: "第一条记忆",
      confidence: "high"
    });
    const b = store.writeEntry({
      kind: "fact",
      targetScope: "global",
      statement: "第二条记忆",
      confidence: "high"
    });

    const found = store.updateEntryStatus({
      scope: b.frontmatter.scope,
      workspaceSlug: undefined,
      id: b.frontmatter.id,
      status: "archived"
    });
    expect(found.frontmatter.id).toBe(b.frontmatter.id);
    expect(found.frontmatter.id).not.toBe(a.frontmatter.id);

    const aState = store.updateEntryStatus({
      scope: a.frontmatter.scope,
      workspaceSlug: undefined,
      id: a.frontmatter.id,
      status: "active"
    });
    expect(aState.frontmatter.id).toBe(a.frontmatter.id);
    expect(aState.frontmatter.status).toBe("active");
  });

  test("readActivation 无字段 → 默认全 true（兼容旧记忆）", () => {
    const fm = {
      id: "mem_x",
      kind: "fact",
      scope: "global",
      status: "active"
    } as Partial<MemoryV2EntryFrontmatter> as MemoryV2EntryFrontmatter;
    expect(readActivation(fm)).toEqual(DEFAULT_ACTIVATION);
    expect(readActivation(fm)).toEqual({
      recall: true,
      persona: true,
      suggestion: true,
      analyst: true
    });
  });

  test("readActivation 有字段 → 返回实际值", () => {
    const fm = {
      activation: { recall: true, persona: false, suggestion: true, analyst: false }
    } as Partial<MemoryV2EntryFrontmatter> as MemoryV2EntryFrontmatter;
    expect(readActivation(fm)).toEqual({
      recall: true,
      persona: false,
      suggestion: true,
      analyst: false
    });
  });

  test("writeEntry 新记忆默认 activation 全 true", () => {
    const entry = writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "默认激活全 true",
      confidence: "high"
    });
    expect(entry.frontmatter.activation).toEqual(DEFAULT_ACTIVATION);
    expect(readActivation(readEntryFile(entry.path).frontmatter)).toEqual(DEFAULT_ACTIVATION);
  });

  test("resolvePending accept 继承被 supersede 旧版的 activation", () => {
    const store = createMemoryV2Store();
    const oldActivation = { recall: true, persona: false, suggestion: true, analyst: false };
    const existing = store.writeEntry({
      kind: "preference",
      targetScope: "global",
      statement: "用户希望被称呼为 Mason",
      confidence: "high",
      claim: {
        subject: "user/self",
        predicate: "preferred_name",
        object: "Mason"
      }
    }, { activation: oldActivation });

    const pending = store.writePending({
      type: "conflict",
      candidate: {
        kind: "preference",
        targetScope: "global",
        statement: "用户希望被称呼为 Alice",
        confidence: "high",
        tags: ["profile", "identity", "preferred-name"],
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      },
      existingIds: [existing.frontmatter.id],
      reason: "同一称呼偏好发生变化"
    });

    const result = resolvePending({
      workspaceSlug: "demo",
      path: pending.path,
      action: "accept"
    });

    const entryId = result.entryId;
    if (!entryId) throw new Error("pending accept did not create entry");
    const accepted = listEntries({ scopes: ["global"], includeStatuses: ["active"] })
      .find((entry) => entry.frontmatter.id === entryId);
    expect(accepted?.frontmatter.activation).toEqual(oldActivation);
    expect(readEntryFile(accepted!.path).frontmatter.activation).toEqual(oldActivation);
  });

  test("resolvePending accept 无 existing → DEFAULT_ACTIVATION", () => {
    const store = createMemoryV2Store();
    const pending = store.writePending({
      type: "low-confidence",
      candidate: {
        kind: "fact",
        targetScope: "global",
        statement: "Maybe this project uses a custom release checklist.",
        confidence: "low"
      },
      reason: "低置信度待审"
    });

    const result = resolvePending({
      workspaceSlug: "demo",
      path: pending.path,
      action: "accept"
    });

    const entryId = result.entryId;
    if (!entryId) throw new Error("pending accept did not create entry");
    const accepted = listEntries({ scopes: ["global"], includeStatuses: ["active"] })
      .find((entry) => entry.frontmatter.id === entryId);
    expect(accepted?.frontmatter.activation).toEqual(DEFAULT_ACTIVATION);
  });
});

function updateEntryStatusForTest(id: string, supersededBy: string): void {
  createMemoryV2Store().updateEntryStatus({
    scope: "workspace",
    workspaceSlug: "demo",
    id,
    status: "superseded",
    supersededBy
  });
}
