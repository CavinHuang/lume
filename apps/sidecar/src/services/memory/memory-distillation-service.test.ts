import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentWorkspacePath, getGlobalMemoryPath } from "../infra/config-paths";
import { distillWorkspaceMemory } from "./memory-distillation-service";
import { searchLayeredMemory, closeMemoryManagers } from "./memory-service";

describe("memory-distillation-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-memory-distill-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    closeMemoryManagers();
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
    expect(result.createdItems).toBe(1);
    expect(readFileSync(join(workspacePath, "MEMORY.md"), "utf-8")).toContain("stable preference");

    const found = await searchLayeredMemory({
      workspaceSlug,
      query: "stable preference",
      maxResults: 5,
      sources: ["distillation"]
    });
    expect(found.some((item) => item.kind === "preference" && item.source === "distillation")).toBeTrue();
  });

  test("应将 decision 蒸馏进 WORKSPACE.md 的 Important Decisions", async () => {
    const workspaceSlug = "demo-workspace-brief";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const memoryDir = join(workspacePath, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, "2026-04-11.md"),
      "- [decision] Structured memory stays local and auditable.\n- [decision] Structured memory stays local and auditable.\n",
      "utf-8"
    );

    const result = await distillWorkspaceMemory({ workspaceSlug });

    expect(result.updatedWorkspaceBrief).toBeTrue();
    expect(readFileSync(join(workspacePath, "WORKSPACE.md"), "utf-8")).toContain(
      "Structured memory stays local and auditable."
    );
  });

  test("重复执行 distill 不应重复创建相同 structured item", async () => {
    const workspaceSlug = "demo-idempotent";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const memoryDir = join(workspacePath, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "2026-04-11.md"), "- stable lesson\n- stable lesson\n", "utf-8");

    const first = await distillWorkspaceMemory({ workspaceSlug });
    const second = await distillWorkspaceMemory({ workspaceSlug });

    expect(first.createdItems).toBe(1);
    expect(second.createdItems).toBe(0);
  });

  test("generateGlobalCandidates=true 时应生成全局候选", async () => {
    const workspaceSlug = "demo-global-candidate";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const memoryDir = join(workspacePath, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, "2026-04-11.md"),
      "- [preference] User prefers concise implementation plans with verification.\n- [preference] User prefers concise implementation plans with verification.\n",
      "utf-8"
    );

    const result = await distillWorkspaceMemory({
      workspaceSlug,
      generateGlobalCandidates: true
    });

    expect(result.globalCandidateCount).toBe(1);
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
