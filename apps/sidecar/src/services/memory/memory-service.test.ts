import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeMemoryManagers,
  searchLayeredMemory,
  syncGlobalMemoryPath,
  syncWorkspaceMemoryPath,
  writeWorkspaceMemory
} from "./memory-service";
import { MemoryRepository } from "./memory-repository";
import {
  getAgentWorkspacePath,
  getGlobalMemoryPath,
  getGlobalStructuredMemoryPath,
  getGlobalStructuredMemoryDbPath
} from "../infra/config-paths";

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

describe("memory-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-memory-service-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    closeMemoryManagers();
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      removeDirWithRetry(tempConfigDir);
      tempConfigDir = "";
    }
  });

  test("syncWorkspaceMemoryPath 处理文件新增和删除", async () => {
    closeMemoryManagers();
    const workspaceSlug = `memory-sync-${Date.now()}`;
    const root = getAgentWorkspacePath(workspaceSlug);
    mkdirSync(join(root, "memory"), { recursive: true });

    const memoryFile = join(root, "memory", "2026-02-12.md");
    writeFileSync(memoryFile, "hello memory", "utf-8");

    const first = await syncWorkspaceMemoryPath({
      workspaceSlug,
      absolutePath: memoryFile
    });
    expect(first.indexedChunks).toBeGreaterThan(0);

    unlinkSync(memoryFile);
    const second = await syncWorkspaceMemoryPath({
      workspaceSlug,
      absolutePath: memoryFile
    });
    expect(second.removed).toBeTrue();

    closeMemoryManagers();
  });

  test("syncWorkspaceMemoryPath 支持 MEMORY.md", async () => {
    closeMemoryManagers();
    const workspaceSlug = `memory-sync-alt-${Date.now()}`;
    const root = getAgentWorkspacePath(workspaceSlug);
    mkdirSync(root, { recursive: true });

    const memoryFile = join(root, "MEMORY.md");
    writeFileSync(memoryFile, "alt memory", "utf-8");

    const result = await syncWorkspaceMemoryPath({
      workspaceSlug,
      absolutePath: memoryFile
    });
    expect(result.indexedChunks).toBeGreaterThan(0);

    closeMemoryManagers();
  });

  test("syncWorkspaceMemoryPath 支持 WORKSPACE.md", async () => {
    closeMemoryManagers();
    const workspaceSlug = `memory-sync-workspace-${Date.now()}`;
    const root = getAgentWorkspacePath(workspaceSlug);
    mkdirSync(root, { recursive: true });

    const workspaceFile = join(root, "WORKSPACE.md");
    writeFileSync(workspaceFile, "workspace brief marker", "utf-8");

    const result = await syncWorkspaceMemoryPath({
      workspaceSlug,
      absolutePath: workspaceFile
    });
    expect(result.indexedChunks).toBeGreaterThan(0);

    const results = await searchLayeredMemory({
      workspaceSlug,
      query: "workspace brief marker",
      maxResults: 5
    });
    expect(results.some((item) => item.path === "WORKSPACE.md")).toBeTrue();

    closeMemoryManagers();
  });

  test("syncGlobalMemoryPath 支持 ~/.lume/MEMORY.md", async () => {
    closeMemoryManagers();
    const globalMemoryPath = getGlobalMemoryPath();
    writeFileSync(globalMemoryPath, "global memory", "utf-8");

    const result = await syncGlobalMemoryPath({
      absolutePath: globalMemoryPath
    });
    expect(result.indexedChunks).toBeGreaterThan(0);

    closeMemoryManagers();
  });

  test("searchLayeredMemory 不应把 workspace MEMORY.md 误标成全局 MEMORY", async () => {
    closeMemoryManagers();
    const workspaceSlug = `memory-search-layered-${Date.now()}`;
    const root = getAgentWorkspacePath(workspaceSlug);
    mkdirSync(root, { recursive: true });

    writeFileSync(join(root, "MEMORY.md"), "workspace only marker", "utf-8");
    writeFileSync(getGlobalMemoryPath(), "global only marker", "utf-8");

    const workspaceResults = await searchLayeredMemory({
      workspaceSlug,
      query: "workspace only marker",
      maxResults: 5
    });
    expect(workspaceResults.some((item) => item.path === "MEMORY.md")).toBeTrue();
    expect(workspaceResults.some((item) => item.path === "~/.lume/MEMORY.md" && item.snippet.includes("workspace only marker"))).toBeFalse();

    const globalResults = await searchLayeredMemory({
      workspaceSlug,
      query: "global only marker",
      maxResults: 5
    });
    expect(globalResults.some((item) => item.path === "~/.lume/MEMORY.md")).toBeTrue();

    closeMemoryManagers();
  });

  test("searchLayeredMemory 可按 includeGlobal 控制结构化全局记忆召回", async () => {
    closeMemoryManagers();
    const workspaceSlug = `memory-search-global-${Date.now()}`;
    const repository = new MemoryRepository({
      dbPath: getGlobalStructuredMemoryDbPath(),
      workspaceSlug: "__global__"
    });
    const item = await repository.save({
      workspaceSlug: "__global__",
      scope: "global",
      kind: "preference",
      source: "promotion",
      content: "User prefers durable auditable memory controls.",
      importance: 5,
      confidence: 0.95
    });
    repository.dispose();

    const localOnly = await searchLayeredMemory({
      workspaceSlug,
      query: "auditable memory controls",
      maxResults: 5,
      includeGlobal: false
    });
    expect(localOnly.some((entry) => entry.id === item.id)).toBeFalse();

    const withGlobal = await searchLayeredMemory({
      workspaceSlug,
      query: "auditable memory controls",
      maxResults: 5,
      includeGlobal: true
    });
    expect(withGlobal[0]).toEqual(expect.objectContaining({
      id: item.id,
      path: getGlobalStructuredMemoryPath(),
      scope: "global",
      source: "promotion"
    }));

    closeMemoryManagers();
  });

  test("writeWorkspaceMemory 保留结构化字段", async () => {
    closeMemoryManagers();
    const workspaceSlug = `memory-write-structured-${Date.now()}`;

    const saved = await writeWorkspaceMemory({
      workspaceSlug,
      content: "User prefers visible and reviewable memory changes.",
      kind: "preference",
      scope: "workspace",
      source: "manual",
      importance: 5,
      confidence: 0.9,
      tags: ["memory", "review"]
    });

    const results = await searchLayeredMemory({
      workspaceSlug,
      query: "reviewable memory changes",
      maxResults: 5,
      includeGlobal: false
    });
    expect(results.find((entry) => entry.id === saved.itemId)).toEqual(expect.objectContaining({
      kind: "preference",
      scope: "workspace",
      source: "manual",
      importanceScore: 1
    }));

    closeMemoryManagers();
  });
});
