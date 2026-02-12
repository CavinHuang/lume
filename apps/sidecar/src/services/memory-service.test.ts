import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeMemoryManagers, syncWorkspaceMemoryPath } from "./memory-service";
import { getAgentWorkspacePath } from "./config-paths";

describe("memory-service", () => {
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
});
