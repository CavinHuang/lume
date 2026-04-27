import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRepository } from "./memory-repository";

function removeDirWithRetry(path: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

describe("memory-repository", () => {
  test("save 应持久化结构化记忆、更新 FTS 并记录 audit", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-repository-"));
    const repository = new MemoryRepository({
      dbPath: join(root, "memory.sqlite"),
      workspaceSlug: "default"
    });

    try {
      const saved = await repository.save({
        workspaceSlug: "default",
        scope: "workspace",
        kind: "decision",
        source: "manual",
        title: "Structured memory",
        content: "Lume should keep visible, auditable workspace journey memory.",
        tags: ["memory", "workspace"],
        topics: ["journey"],
        importance: 5,
        confidence: 0.9
      });

      expect(saved.id).toBeTruthy();
      expect(saved.createdAt).toBeGreaterThan(0);
      expect(saved.updatedAt).toBe(saved.createdAt);

      const loaded = await repository.get(saved.id);
      expect(loaded?.kind).toBe("decision");
      expect(loaded?.tags).toEqual(["memory", "workspace"]);

      const results = await repository.search({
        workspaceSlug: "default",
        query: "auditable journey",
        kinds: ["decision"],
        scopes: ["workspace"],
        maxResults: 5
      });
      expect(results[0]?.id).toBe(saved.id);
      expect(results[0]?.kind).toBe("decision");
      expect(results[0]?.source).toBe("manual");
      expect(results[0]?.importanceScore).toBeGreaterThan(0);

      const audit = repository.listAuditLog();
      expect(audit).toEqual([
        expect.objectContaining({
          operation: "save",
          memoryId: saved.id,
          workspaceSlug: "default"
        })
      ]);
    } finally {
      repository.dispose();
      removeDirWithRetry(root);
    }
  });

  test("invalidate 应设置 validTo 而不是删除记忆", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-repository-"));
    const repository = new MemoryRepository({
      dbPath: join(root, "memory.sqlite"),
      workspaceSlug: "default"
    });

    try {
      const saved = await repository.save({
        workspaceSlug: "default",
        scope: "workspace",
        kind: "fact",
        source: "manual",
        content: "The old model picker lives in ChannelSettings.",
        importance: 3,
        confidence: 1
      });

      await repository.invalidate(saved.id, 1234);
      const loaded = await repository.get(saved.id);

      expect(loaded?.validTo).toBe(1234);
      expect(repository.listAuditLog().at(-1)).toEqual(
        expect.objectContaining({
          operation: "invalidate",
          memoryId: saved.id
        })
      );
    } finally {
      repository.dispose();
      removeDirWithRetry(root);
    }
  });
});
