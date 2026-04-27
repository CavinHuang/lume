import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateGlobalCandidates,
  listGlobalMemoryCandidates,
  promoteGlobalMemory,
  rejectGlobalMemoryCandidate,
  searchGlobalMemory
} from "./memory-global-promoter";
import { MemoryRepository } from "./memory-repository";
import { getGlobalStructuredMemoryPath, getWorkspaceMemoryDbPath } from "../infra/config-paths";

describe("memory-global-promoter", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-global-memory-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("generateGlobalCandidates 应从高置信 workspace 偏好生成待确认候选", async () => {
    const workspaceSlug = "demo";
    const repository = new MemoryRepository({
      dbPath: getWorkspaceMemoryDbPath(workspaceSlug),
      workspaceSlug
    });
    const item = await repository.save({
      workspaceSlug,
      scope: "workspace",
      kind: "preference",
      source: "distillation",
      content: "User prefers concise implementation plans with clear verification.",
      importance: 5,
      confidence: 0.9
    });
    repository.dispose();

    const candidates = await generateGlobalCandidates({
      workspaceSlug,
      memoryIds: [item.id]
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(expect.objectContaining({
      workspaceSlug,
      memoryIds: [item.id],
      kind: "preference",
      status: "pending",
      importance: 5
    }));

    const listed = await listGlobalMemoryCandidates({ status: "pending" });
    expect(listed.map((candidate) => candidate.id)).toEqual([candidates[0]!.id]);
  });

  test("promoteGlobalMemory approve 应写 GLOBAL.md、global sqlite 并支持搜索", async () => {
    const workspaceSlug = "demo-approve";
    const repository = new MemoryRepository({
      dbPath: getWorkspaceMemoryDbPath(workspaceSlug),
      workspaceSlug
    });
    const item = await repository.save({
      workspaceSlug,
      scope: "workspace",
      kind: "lesson",
      source: "distillation",
      content: "User values local-first memory that remains auditable.",
      importance: 4,
      confidence: 0.8
    });
    repository.dispose();
    const [candidate] = await generateGlobalCandidates({ workspaceSlug, memoryIds: [item.id] });

    const promoted = await promoteGlobalMemory({
      candidateId: candidate!.id,
      approve: true,
      editedContent: "User values local-first memory with auditable changes."
    });

    expect(promoted.scope).toBe("global");
    expect(promoted.source).toBe("promotion");
    expect(promoted.promotedFrom).toEqual({
      workspaceSlug,
      memoryIds: [item.id],
      reason: expect.any(String)
    });
    expect(readFileSync(getGlobalStructuredMemoryPath(), "utf-8")).toContain(
      "User values local-first memory with auditable changes."
    );

    const candidates = await listGlobalMemoryCandidates({ status: "approved" });
    expect(candidates[0]?.id).toBe(candidate!.id);

    const results = await searchGlobalMemory({ query: "auditable changes", maxResults: 5 });
    expect(results[0]).toEqual(expect.objectContaining({
      id: promoted.id,
      scope: "global",
      source: "promotion"
    }));
  });

  test("rejectGlobalMemoryCandidate 应拒绝候选且不创建 GLOBAL.md", async () => {
    const workspaceSlug = "demo-reject";
    const repository = new MemoryRepository({
      dbPath: getWorkspaceMemoryDbPath(workspaceSlug),
      workspaceSlug
    });
    const item = await repository.save({
      workspaceSlug,
      scope: "workspace",
      kind: "fact",
      source: "distillation",
      content: "User generally prefers explicit verification evidence.",
      importance: 4,
      confidence: 0.9
    });
    repository.dispose();
    const [candidate] = await generateGlobalCandidates({ workspaceSlug, memoryIds: [item.id] });

    const rejected = await rejectGlobalMemoryCandidate(candidate!.id);

    expect(rejected.status).toBe("rejected");
    expect(existsSync(getGlobalStructuredMemoryPath())).toBeFalse();
  });
});
