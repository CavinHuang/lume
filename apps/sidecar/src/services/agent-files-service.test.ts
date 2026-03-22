import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listAttachedDirectory,
  moveAttachedPath,
  renameAttachedPath,
  moveAgentFile,
  renameAgentFile,
  searchAgentWorkspaceFiles,
  deleteAgentPlan,
  getAgentSessionPath,
  listAgentPlans,
  readAgentPlan
} from "./agent-files-service";

const createdDirs: string[] = [];
const originalConfigDir = process.env.LUME_CONFIG_DIR;

function createTempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lume-agent-files-"));
  createdDirs.push(dir);
  process.env.LUME_CONFIG_DIR = dir;
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env.LUME_CONFIG_DIR = originalConfigDir;
});

describe("agent-files-service plans", () => {
  test("应支持 list/read/delete plan 文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-a";
    const sessionId = "session-a";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const plansDir = join(sessionDir, "plans");
    mkdirSync(plansDir, { recursive: true });

    const planFileName = "20260218-demo-plan.md";
    const planPath = join(plansDir, planFileName);
    writeFileSync(
      planPath,
      "---\nsummary: \"演示计划\"\ncreated: 2026-02-18T00:00:00.000Z\nslug: 20260218-demo-plan\n---\n# Plan\nstep 1\n",
      "utf-8"
    );
    writeFileSync(join(plansDir, "plan.md"), "# latest\n", "utf-8");

    const plans = listAgentPlans(workspaceSlug, sessionId);
    expect(plans.length).toBe(2);
    expect(plans.some((item) => item.name === planFileName)).toBeTrue();
    const targetPlan = plans.find((item) => item.name === planFileName);
    expect(targetPlan?.summary).toBe("演示计划");

    const readResult = readAgentPlan(workspaceSlug, sessionId, planFileName);
    expect(readResult.path.endsWith(`/plans/${planFileName}`) || readResult.path.endsWith(`\\plans\\${planFileName}`)).toBeTrue();
    expect(readResult.content.includes("step 1")).toBeTrue();

    const deleteResult = deleteAgentPlan(workspaceSlug, sessionId, planFileName);
    expect(deleteResult.ok).toBeTrue();
    const remaining = listAgentPlans(workspaceSlug, sessionId);
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.name).toBe("plan.md");
  });

  test("应拒绝读取越界 plan 路径", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-b";
    const sessionId = "session-b";
    getAgentSessionPath(workspaceSlug, sessionId);

    expect(() => readAgentPlan(workspaceSlug, sessionId, "../secrets.md")).toThrow(
      "Plan 路径超出会话 plans 目录"
    );
  });
});

describe("agent-files-service file ops", () => {
  test("应支持重命名文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-c";
    const sessionId = "session-c";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const filePath = join(sessionDir, "old-name.txt");
    writeFileSync(filePath, "hello", "utf-8");

    const result = renameAgentFile(workspaceSlug, sessionId, filePath, "new-name.txt");
    expect(result.ok).toBeTrue();
    expect(existsSync(result.path)).toBeTrue();
    expect(readdirSync(sessionDir)).toContain("new-name.txt");
    expect(readdirSync(sessionDir)).not.toContain("old-name.txt");
  });

  test("应支持移动文件到目标目录", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-d";
    const sessionId = "session-d";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const sourceDir = join(sessionDir, "src");
    const targetDir = join(sessionDir, "dst");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    const sourcePath = join(sourceDir, "task.md");
    writeFileSync(sourcePath, "# task", "utf-8");

    const result = moveAgentFile(workspaceSlug, sessionId, sourcePath, targetDir);
    expect(result.ok).toBeTrue();
    expect(existsSync(result.path)).toBeTrue();
    expect(existsSync(sourcePath)).toBeFalse();
  });

  test("应支持搜索工作区文件", () => {
    createTempConfigDir();
    const workspaceSlug = "workspace-e";
    const sessionId = "session-e";
    const sessionDir = getAgentSessionPath(workspaceSlug, sessionId);
    const docsDir = join(sessionDir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(sessionDir, "README.md"), "root", "utf-8");
    writeFileSync(join(docsDir, "agent-guide.md"), "guide", "utf-8");
    writeFileSync(join(docsDir, "notes.txt"), "notes", "utf-8");

    const result = searchAgentWorkspaceFiles(workspaceSlug, sessionId, "ag", 20, sessionDir);
    expect(result.total).toBeGreaterThan(0);
    expect(result.entries.some((entry) => entry.name === "agent-guide.md")).toBeTrue();
  });

  test("应支持附加目录列出/重命名/移动", () => {
    createTempConfigDir();
    const tempRoot = mkdtempSync(join(tmpdir(), "lume-attached-"));
    createdDirs.push(tempRoot);
    const docsDir = join(tempRoot, "docs");
    const movedDir = join(tempRoot, "moved");
    mkdirSync(docsDir, { recursive: true });
    mkdirSync(movedDir, { recursive: true });
    const sourceFile = join(docsDir, "todo.txt");
    writeFileSync(sourceFile, "todo", "utf-8");

    const listed = listAttachedDirectory(docsDir);
    expect(listed.length).toBe(1);
    expect(listed[0]?.name).toBe("todo.txt");

    const renamed = renameAttachedPath(sourceFile, "tasks.txt");
    expect(renamed.ok).toBeTrue();
    expect(existsSync(renamed.path)).toBeTrue();
    expect(existsSync(sourceFile)).toBeFalse();

    const moved = moveAttachedPath(renamed.path, movedDir);
    expect(moved.ok).toBeTrue();
    expect(existsSync(moved.path)).toBeTrue();
    expect(existsSync(renamed.path)).toBeFalse();
  });
});
