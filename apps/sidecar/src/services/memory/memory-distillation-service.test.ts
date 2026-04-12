import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentWorkspacePath, getGlobalMemoryPath } from "../infra/config-paths";
import { distillWorkspaceMemory } from "./memory-distillation-service";

describe("memory-distillation-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-memory-distill-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("应将重复的 workspace 短期记忆提炼进 workspace MEMORY.md", async () => {
    const workspaceSlug = "demo";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const memoryDir = join(workspacePath, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "2026-04-11.md"), "- stable preference\n- stable preference\n", "utf-8");

    const result = await distillWorkspaceMemory({ workspaceSlug });
    expect(result.updatedWorkspaceMemory).toBeTrue();
    expect(readFileSync(join(workspacePath, "MEMORY.md"), "utf-8")).toContain("stable preference");
  });

  test("标记为 [global] 的 workspace 长期记忆应可上浮到全局 MEMORY.md", async () => {
    const workspaceSlug = "demo-global";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, "MEMORY.md"), "[global] user prefers terse technical answers\n", "utf-8");

    const result = await distillWorkspaceMemory({ workspaceSlug });
    expect(result.promotedToGlobal).toContain("user prefers terse technical answers");
    expect(readFileSync(getGlobalMemoryPath(), "utf-8")).toContain("user prefers terse technical answers");
  });
});
