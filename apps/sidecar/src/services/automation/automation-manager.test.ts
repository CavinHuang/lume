import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAutomationJob,
  deleteAutomationJob,
  listAutomationJobs,
  updateAutomationJob
} from "./automation-manager";
import { getAutomationJobsPath, getRoutineSchedulePath } from "../infra/config-paths";

describe("automation-manager", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-automation-manager-"));
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

  test("应支持任务 create/list/update/delete", () => {
    const created = createAutomationJob({
      name: "每日日报准备",
      schedule: { type: "cron", cronExpr: "30 8 * * 1-5", timezone: "Asia/Shanghai" },
      prompt: "汇总昨日进展并生成日报草稿"
    });
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.enabled).toBeTrue();

    const listed = listAutomationJobs();
    expect(listed.length).toBe(1);
    expect(listed[0]?.name).toBe("每日日报准备");

    const updated = updateAutomationJob({
      id: created.id,
      enabled: false,
      prompt: "汇总昨日进展并生成日报"
    });
    expect(updated.enabled).toBeFalse();
    expect(updated.prompt).toBe("汇总昨日进展并生成日报");

    const deleted = deleteAutomationJob({ id: created.id });
    expect(deleted.ok).toBeTrue();
    expect(listAutomationJobs()).toEqual([]);
  });

  test("应保留自动化管理页的手动触发与展示元数据", () => {
    const created = createAutomationJob({
      name: "PRD 初稿生成",
      description: "根据需求文档，生成产品需求文档初稿",
      schedule: { type: "manual" },
      prompt: "阅读并理解需求文档，输出结构清晰的 PRD 初稿",
      triggerModes: ["manual", "chat"],
      source: "manual",
      toolResourceIds: ["file", "prd", "design"],
      defaultModel: "GPT-5.1"
    });

    expect(created.schedule).toEqual({ type: "manual" });
    expect(created.triggerModes).toEqual(["manual", "chat"]);
    expect(created.source).toBe("manual");
    expect(created.toolResourceIds).toEqual(["file", "prd", "design"]);
    expect(created.description).toBe("根据需求文档，生成产品需求文档初稿");
    expect(created.defaultModel).toBe("GPT-5.1");

    const updated = updateAutomationJob({
      id: created.id,
      triggerModes: ["manual", "schedule", "chat"],
      toolResourceIds: ["file", "web", "prd"],
      schedule: { type: "cron", cronExpr: "0 9 * * *" }
    });

    expect(updated.schedule).toEqual({ type: "cron", cronExpr: "0 9 * * *" });
    expect(updated.source).toBe("manual");
    expect(updated.triggerModes).toEqual(["manual", "schedule", "chat"]);
    expect(updated.toolResourceIds).toEqual(["file", "web", "prd"]);
    expect(listAutomationJobs()[0]?.triggerModes).toEqual(["manual", "schedule", "chat"]);
  });

  test("应维护可调度任务的 nextRunAt 状态", () => {
    const futureRunAt = Date.now() + 60_000;
    const once = createAutomationJob({
      name: "稍后提醒",
      schedule: { type: "once", runAt: futureRunAt },
      prompt: "提醒我检查发布状态"
    });
    expect(once.nextRunAt).toBe(futureRunAt);
    expect(once.lastRunAt).toBeUndefined();

    const disabled = updateAutomationJob({
      id: once.id,
      enabled: false
    });
    expect(disabled.nextRunAt).toBeNull();

    const interval = updateAutomationJob({
      id: once.id,
      enabled: true,
      schedule: { type: "interval", intervalMs: 60_000 }
    });
    expect(interval.nextRunAt).toBeGreaterThanOrEqual(interval.updatedAt + 59_000);
    expect(interval.nextRunAt).toBeLessThanOrEqual(interval.updatedAt + 61_000);

    const manual = updateAutomationJob({
      id: once.id,
      schedule: { type: "manual" }
    });
    expect(manual.nextRunAt).toBeNull();
  });

  test("应将日程引用的旧自动化任务标记为系统任务", () => {
    const created = createAutomationJob({
      name: "旧日程任务",
      schedule: { type: "once", runAt: Date.now() + 60_000 },
      prompt: "执行日程条目"
    });
    writeFileSync(getRoutineSchedulePath("2026-06-19"), JSON.stringify({
      id: "routine-1",
      date: "2026-06-19",
      generatedAt: Date.now(),
      status: "planned",
      context: {
        activeBooks: 0,
        unfinishedTodos: 0,
        dayOfWeek: 5,
        recentNotes: 0,
        pendingMemories: 0
      },
      entries: [{
        id: "entry-1",
        activity: "daily_summary",
        scheduledAt: Date.now(),
        status: "pending",
        automationJobId: created.id
      }]
    }), "utf-8");

    const listed = listAutomationJobs();
    expect(listed[0]?.source).toBe("system");
    expect(listed[0]?.systemAction).toBe("routine");
  });

  test("索引损坏时应自动备份并回退空列表", () => {
    const indexPath = getAutomationJobsPath();
    writeFileSync(indexPath, "{broken-json", "utf-8");
    const jobs = listAutomationJobs();
    expect(jobs).toEqual([]);
    expect(existsSync(indexPath)).toBeFalse();
    const automationDir = join(tempConfigDir, "automation");
    const files = existsSync(automationDir) ? readdirSync(automationDir) : [];
    expect(files.some((name) => name.startsWith("jobs.json.corrupt-"))).toBeTrue();
  });
});
