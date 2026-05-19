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
import { getAutomationJobsPath } from "../infra/config-paths";

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
      toolResourceIds: ["file", "prd", "design"],
      defaultModel: "GPT-5.1"
    });

    expect(created.schedule).toEqual({ type: "manual" });
    expect(created.triggerModes).toEqual(["manual", "chat"]);
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
    expect(updated.triggerModes).toEqual(["manual", "schedule", "chat"]);
    expect(updated.toolResourceIds).toEqual(["file", "web", "prd"]);
    expect(listAutomationJobs()[0]?.triggerModes).toEqual(["manual", "schedule", "chat"]);
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
