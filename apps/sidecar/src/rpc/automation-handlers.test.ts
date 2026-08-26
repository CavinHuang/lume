import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOMATION_IPC_CHANNELS } from "@lume/shared";
import { getAutomationJobsPath } from "../services/infra/config-paths";
import { createAutomationJob } from "../services/automation/automation-manager";
import { stopAutomationRunner } from "../services/automation/automation-runner-service";

/**
 * Handler 接线测试（#647 P2-23）：走真实 manager + 临时 LUME_CONFIG_DIR，
 * 钉死“渲染进程不得铸造/劫持无人值守 bypass 通道”的边界语义。
 */

describe("automation-handlers 边界(#647 P2-23)", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";
  let handlers: Record<string, (params: unknown) => Promise<unknown>>;

  beforeEach(async () => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-automation-handlers-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
    const { createAutomationHandlers } = await import("./automation-handlers");
    handlers = createAutomationHandlers();
  });

  afterEach(async () => {
    // 集成法真拉起了 runner：复位模块态，防单进程合跑毒杀兄弟 runner 测试
    await stopAutomationRunner();
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("CREATE 注入 source:'system' 也被服务端强制为 manual", async () => {
    await handlers[AUTOMATION_IPC_CHANNELS.CREATE_JOB]!({
      name: "越权探测",
      prompt: "probe",
      schedule: { type: "manual" },
      // zod 已剥离注入字段，此处即便穿透也由 handler 覆写兜底
      source: "system",
      systemAction: "routine",
    });

    const raw = JSON.parse(readFileSync(getAutomationJobsPath(), "utf-8")) as {
      jobs: Array<{ name: string; source?: string; systemAction?: string }>;
    };
    expect(raw.jobs).toHaveLength(1);
    expect(raw.jobs[0]!.name).toBe("越权探测");
    expect(raw.jobs[0]!.source).toBe("manual");
    expect(raw.jobs[0]!.systemAction).toBeUndefined();
  });

  test("UPDATE/TOGGLE/DELETE 对 system 任务拒绝改写、启停与删除", async () => {
    const systemJob = createAutomationJob({
      name: "例行任务",
      prompt: "p",
      schedule: { type: "manual" },
      source: "system",
    });
    // 模拟 routine 映射（listRoutineAutomationJobIds 命中后 source 以 system 呈现）
    const routineDir = join(tempConfigDir, "routine", "schedules");
    mkdirSync(routineDir, { recursive: true });
    writeFileSync(
      join(routineDir, "2026-08-25.json"),
      JSON.stringify({ date: "2026-08-25", status: "planned", entries: [{ id: "e1", activity: "todo_review", automationJobId: systemJob.id }] }),
      "utf-8",
    );

    await expect(
      handlers[AUTOMATION_IPC_CHANNELS.UPDATE_JOB]!({ id: systemJob.id, prompt: "换血后的提示词" }),
    ).rejects.toThrow("不可在界面中修改");
    await expect(
      handlers[AUTOMATION_IPC_CHANNELS.TOGGLE_JOB]!({ id: systemJob.id }),
    ).rejects.toThrow("不可在界面中启停");
    await expect(
      handlers[AUTOMATION_IPC_CHANNELS.DELETE_JOB]!({ id: systemJob.id }),
    ).rejects.toThrow("不可在界面中删除");
  });
});
