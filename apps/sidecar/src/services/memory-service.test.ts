import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeMemoryManagers, syncWorkspaceMemoryPath } from "./memory-service";
import { getAgentWorkspacePath } from "./config-paths";

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
      rmSync(tempConfigDir, { recursive: true, force: true });
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
    rmSync(root, { recursive: true, force: true });
  });

  test("syncWorkspaceMemoryPath 支持 memory.md", async () => {
    closeMemoryManagers();
    const workspaceSlug = `memory-sync-alt-${Date.now()}`;
    const root = getAgentWorkspacePath(workspaceSlug);
    mkdirSync(root, { recursive: true });

    const memoryFile = join(root, "memory.md");
    writeFileSync(memoryFile, "alt memory", "utf-8");

    const result = await syncWorkspaceMemoryPath({
      workspaceSlug,
      absolutePath: memoryFile
    });
    expect(result.indexedChunks).toBeGreaterThan(0);

    closeMemoryManagers();
    rmSync(root, { recursive: true, force: true });
  });
});
