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

  test("索引损坏时备份副本并检疫写入，修复后解除(#647 P2-22)", () => {
    const indexPath = getAutomationJobsPath();
    writeFileSync(indexPath, "{broken-json", "utf-8");

    // 读降级为空表，但损坏文件保留在位 + 备份副本生成
    expect(listAutomationJobs()).toEqual([]);
    expect(existsSync(indexPath)).toBeTrue();
    const automationDir = join(tempConfigDir, "automation");
    const files = existsSync(automationDir) ? readdirSync(automationDir) : [];
    expect(files.some((name) => name.startsWith("jobs.json.corrupt-"))).toBeTrue();

    // 检疫期内写操作被阻止（防静默覆盖存量任务），且读路径不受影响
    expect(() =>
      createAutomationJob({ name: "被检疫", schedule: { type: "manual" }, prompt: "x" }),
    ).toThrow("已暂停写入");
    expect(listAutomationJobs()).toEqual([]);

    // 用户删除损坏文件 = 显式放弃，恢复写入；备份副本必须留存（唯一数据副本）
    rmSync(indexPath, { force: true });
    const created = createAutomationJob({ name: "重新开始", schedule: { type: "manual" }, prompt: "x" });
    expect(created.name).toBe("重新开始");
    const filesAfter = existsSync(automationDir) ? readdirSync(automationDir) : [];
    expect(filesAfter.some((name) => name.startsWith("jobs.json.corrupt-"))).toBeTrue();
  });

  test("新一代损坏获得独立备份，同代不重复堆积(#647 P2-22)", () => {
    const indexPath = getAutomationJobsPath();
    const automationDir = join(tempConfigDir, "automation");
    const corruptBackups = () =>
      (existsSync(automationDir) ? readdirSync(automationDir) : []).filter((name) => name.startsWith("jobs.json.corrupt-"));

    // 第一代损坏 → 一份备份
    writeFileSync(indexPath, "{gen-1", "utf-8");
    listAutomationJobs();
    expect(corruptBackups().length).toBe(1);

    // 用户修复 → 检疫解除 → 新建任务（代间数据）
    rmSync(indexPath, { force: true });
    createAutomationJob({ name: "代间任务", schedule: { type: "manual" }, prompt: "x" });

    // 第二代损坏：旧代备份不得抑制新一代备份
    writeFileSync(indexPath, "{gen-2", "utf-8");
    listAutomationJobs();
    expect(corruptBackups().length).toBe(2);

    // 同代重复读不再堆积
    listAutomationJobs();
    listAutomationJobs();
    expect(corruptBackups().length).toBe(2);
  });

  test("索引完好时检疫态自动解除(#647 P2-22)", () => {
    const indexPath = getAutomationJobsPath();
    writeFileSync(indexPath, "{broken-json", "utf-8");
    listAutomationJobs(); // 进入检疫

    // 用户手工把文件修好 → 下一次读成功即解除检疫
    writeFileSync(indexPath, JSON.stringify({ version: 1, jobs: [] }), "utf-8");
    expect(listAutomationJobs()).toEqual([]);

    const created = createAutomationJob({ name: "恢复写入", schedule: { type: "manual" }, prompt: "x" });
    expect(created.name).toBe("恢复写入");
  });
});
