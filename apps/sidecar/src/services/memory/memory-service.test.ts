import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeMemoryManagers, searchLayeredMemory, syncGlobalMemoryPath, syncWorkspaceMemoryPath } from "./memory-service";
import { getAgentWorkspacePath, getGlobalMemoryPath } from "../infra/config-paths";

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
});
