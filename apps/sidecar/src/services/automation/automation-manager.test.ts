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
      prompt: "汇总昨日进展并生成日报草稿",
      systemAction: "memory_distill_workspace"
    });
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.enabled).toBeTrue();
    expect(created.systemAction).toBe("memory_distill_workspace");

    const listed = listAutomationJobs();
    expect(listed.length).toBe(1);
    expect(listed[0]?.name).toBe("每日日报准备");

    const updated = updateAutomationJob({
      id: created.id,
      enabled: false,
      prompt: "汇总昨日进展并生成日报",
      systemAction: "memory_distill_workspace"
    });
    expect(updated.enabled).toBeFalse();
    expect(updated.prompt).toBe("汇总昨日进展并生成日报");
    expect(updated.systemAction).toBe("memory_distill_workspace");

    const deleted = deleteAutomationJob({ id: created.id });
    expect(deleted.ok).toBeTrue();
    expect(listAutomationJobs()).toEqual([]);
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
