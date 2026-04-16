import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAutomationJob } from "./automation-manager";
import { listAutomationRuns, runAutomationJobNow, stopAutomationRunner } from "./automation-runner-service";

describe("automation-runner-service", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-automation-runner-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(async () => {
    await stopAutomationRunner();
    if (oldConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = oldConfigDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  it("应支持立即执行并写入运行记录", async () => {
    const job = createAutomationJob({
      name: "手动执行任务",
      schedule: { type: "interval", intervalMs: 60_000 },
      prompt: "测试"
    });

    const run = await runAutomationJobNow({ id: job.id });
    expect(run.jobId).toBe(job.id);
    expect(["success", "failed", "skipped"]).toContain(run.status);
    expect(run.trigger).toBe("manual");

    const runs = listAutomationRuns({ jobId: job.id, limit: 10 });
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]?.id).toBe(run.id);
  });

  it("运行记录文件应使用 jsonl 追加写入", async () => {
    const job = createAutomationJob({
      name: "追加记录任务",
      schedule: { type: "interval", intervalMs: 60_000 },
      prompt: "测试"
    });
    await runAutomationJobNow({ id: job.id });
    await runAutomationJobNow({ id: job.id });

    const runsPath = join(tempConfigDir, "automation", "runs", "all.jsonl");
    expect(existsSync(runsPath)).toBeTrue();
    const lines = readFileSync(runsPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("应支持直接执行 workspace 记忆蒸馏系统动作", async () => {
    const workspaceId = "ws-memory-distill";
    const workspaceSlug = "memory-distill-workspace";
    const indexPath = join(tempConfigDir, "agent-workspaces.json");
    writeFileSync(indexPath, JSON.stringify({
      version: 1,
      workspaces: [{
        id: workspaceId,
        name: "Memory Distill Workspace",
        slug: workspaceSlug,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }]
    }, null, 2), "utf-8");

    const workspaceRoot = join(tempConfigDir, "agent-workspaces", workspaceSlug);
    mkdirSync(join(workspaceRoot, "memory"), { recursive: true });
    writeFileSync(join(workspaceRoot, "memory", "2026-04-11.md"), "- stable preference\n- stable preference\n", "utf-8");

    const job = createAutomationJob({
      name: "记忆蒸馏",
      workspaceId,
      schedule: { type: "interval", intervalMs: 60_000 },
      prompt: "distill workspace memory",
      systemAction: "memory_distill_workspace"
    });

    const run = await runAutomationJobNow({ id: job.id });
    expect(run.status).toBe("success");
    expect(run.message).toContain("记忆蒸馏完成");
    expect(existsSync(join(workspaceRoot, "MEMORY.md"))).toBeTrue();
  });
});
