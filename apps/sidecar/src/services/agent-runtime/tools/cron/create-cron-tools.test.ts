import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import { createSdkCronTools } from "./create-cron-tools";
import {
  listAutomationRuns,
  startAutomationRunner,
  stopAutomationRunner
} from "../../../automation/automation-runner-service";

function resolveTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`工具不存在: ${name}`);
  }
  return tool;
}

async function callTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const result = await tool.call(input, { cwd: process.cwd(), abortSignal: new AbortController().signal });
  const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
  return (parsed.data ?? parsed) as Record<string, unknown>;
}

describe("create-cron-tools", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-automation-tools-"));
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

  test("应支持任务创建、读取、更新、删除", async () => {
    const tools = createSdkCronTools({ workspaceId: "ws-1", sessionId: "session-main-1" });
    const setTool = resolveTool(tools, "automation_set");
    const readTool = resolveTool(tools, "automation_read");

    const createResult = await callTool(setTool, {
      action: "create",
      name: "早报任务",
      prompt: "生成日报",
      schedule: { type: "cron", cronExpr: "30 8 * * 1-5" }
    });
    const createdJob = (createResult as { job?: { id?: string } }).job;
    expect(Boolean(createdJob?.id)).toBeTrue();
    const createdThreadId = (createResult as { job?: { threadId?: string } }).job?.threadId;
    const createdSource = (createResult as { job?: { source?: string } }).job?.source;
    expect(createdThreadId).toBe("session-main-1");
    expect(createdSource).toBe("manual");

    const readResult = await callTool(readTool, {});
    const jobs = (readResult as { jobs?: Array<{ id: string; name: string }> }).jobs ?? [];
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.name).toBe("早报任务");

    const updateResult = await callTool(setTool, {
      action: "update",
      id: createdJob?.id,
      name: "早报任务-更新"
    });
    const updatedName = (updateResult as { job?: { name?: string } }).job?.name;
    expect(updatedName).toBe("早报任务-更新");

    const deleteResult = await callTool(setTool, {
      action: "delete",
      id: createdJob?.id
    });
    expect((deleteResult as { ok?: boolean }).ok).toBeTrue();

    const readAfterDelete = await callTool(readTool, {});
    const jobsAfterDelete = (readAfterDelete as { jobs?: unknown[] }).jobs ?? [];
    expect(jobsAfterDelete.length).toBe(0);
  });

  test("query 应返回运行记录结构", async () => {
    const tools = createSdkCronTools({ workspaceId: "ws-1" });
    const queryTool = resolveTool(tools, "automation_query");
    const details = await callTool(queryTool, { limit: 5 }) as { ok?: boolean; runs?: unknown[] };
    expect(details.ok).toBeTrue();
    expect(Array.isArray(details.runs)).toBeTrue();
  });

  test("run_now 应异步触发并立即返回 accepted", async () => {
    const tools = createSdkCronTools({ workspaceId: "ws-1", sessionId: "session-main-1" });
    const setTool = resolveTool(tools, "automation_set");

    const createResult = await callTool(setTool, {
      action: "create",
      name: "异步执行任务",
      prompt: "执行一次任务",
      schedule: { type: "interval", intervalMs: 60000 }
    });
    const createdId = (createResult as { job?: { id?: string } }).job?.id;
    expect(Boolean(createdId)).toBeTrue();

    const runNowResult = await callTool(setTool, {
      action: "run_now",
      id: createdId
    });
    const details = runNowResult as { ok?: boolean; accepted?: boolean; message?: string };
    expect(details.ok).toBeTrue();
    expect(details.accepted).toBeTrue();
    expect((details.message ?? "").includes("异步执行")).toBeTrue();
  });

  test("update 应支持将定时任务切回 manual 调度", async () => {
    const tools = createSdkCronTools({ workspaceId: "ws-1", sessionId: "session-main-1" });
    const setTool = resolveTool(tools, "automation_set");

    const createResult = await callTool(setTool, {
      action: "create",
      name: "可切换任务",
      prompt: "按需执行",
      schedule: { type: "cron", cronExpr: "0 9 * * *" }
    });
    const createdId = (createResult as { job?: { id?: string } }).job?.id;
    expect(Boolean(createdId)).toBeTrue();

    const updateResult = await callTool(setTool, {
      action: "update",
      id: createdId,
      schedule: { type: "manual" }
    });

    const updatedSchedule = (updateResult as { job?: { schedule?: { type?: string }; nextRunAt?: number | null } }).job?.schedule;
    const nextRunAt = (updateResult as { job?: { nextRunAt?: number | null } }).job?.nextRunAt;
    expect(updatedSchedule?.type).toBe("manual");
    expect(nextRunAt).toBeNull();
  });

  test("创建定时任务后应刷新正在运行的 scheduler", async () => {
    await startAutomationRunner();
    const tools = createSdkCronTools({ workspaceId: "ws-1", sessionId: "session-main-1" });
    const setTool = resolveTool(tools, "automation_set");

    const createResult = await callTool(setTool, {
      action: "create",
      name: "刷新调度任务",
      prompt: "执行一次刷新验证",
      schedule: { type: "interval", intervalMs: 1000 }
    });
    const createdId = (createResult as { job?: { id?: string } }).job?.id;
    expect(Boolean(createdId)).toBeTrue();

    await new Promise((resolve) => setTimeout(resolve, 1300));

    const runs = listAutomationRuns({ jobId: createdId, limit: 5 });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.trigger).toBe("schedule");
  });
});
