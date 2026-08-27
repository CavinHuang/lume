import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import { createAutomationListTools } from "./automation-list-tools";
import {
  createAutomationJob,
  listAutomationJobs
} from "../../../automation/automation-manager";

function resolveTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  return tool;
}

async function callTool(tool: ToolDefinition, input: Record<string, unknown>) {
  // Call tool and handle both SDK-wrapped and raw result formats
  const result = await tool.call(input, { cwd: process.cwd(), abortSignal: new AbortController().signal });
  if (typeof result.content === 'string') {
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    return (parsed.data ?? parsed) as Record<string, unknown>;
  }
  // Fallback: result.content is undefined, try result directly
  return result as unknown as Record<string, unknown>;
}

describe("automation-list-tools", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-automation-list-tools-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (oldConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = oldConfigDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("无筛选参数时应返回所有任务", async () => {
    createAutomationJob({
      name: "任务A",
      prompt: "promptA",
      schedule: { type: "cron", cronExpr: "0 9 * * *" },
      enabled: true,
    });
    createAutomationJob({
      name: "任务B",
      prompt: "promptB",
      schedule: { type: "interval", intervalMs: 3600000 },
      enabled: false,
    });

    const tools = createAutomationListTools({});
    const listTool = resolveTool(tools, "automation_list");
    const result = await callTool(listTool, {}) as { ok: boolean; total: number; jobs: Array<{ name: string }> };
    expect(result.ok).toBeTrue();
    expect(result.total).toBe(2);
  }, 30_000);

  test("query 应按名称模糊匹配", async () => {
    createAutomationJob({
      name: "每日扫描",
      prompt: "扫描",
      schedule: { type: "cron", cronExpr: "0 9 * * *" },
      enabled: true,
    });
    createAutomationJob({
      name: "每周报告",
      prompt: "报告",
      schedule: { type: "cron", cronExpr: "0 9 * * 1" },
      enabled: true,
    });

    const tools = createAutomationListTools({});
    const listTool = resolveTool(tools, "automation_list");
    const result = await callTool(listTool, { query: "扫描" }) as { ok: boolean; jobs: Array<{ name: string }> };
    expect(result.ok).toBeTrue();
    expect(result.jobs.length).toBe(1);
    expect(result.jobs[0]?.name).toBe("每日扫描");
  }, 30_000);

  test("enabled 应筛选启用状态", async () => {
    createAutomationJob({
      name: "启用任务",
      prompt: "p",
      schedule: { type: "manual" },
      enabled: true,
    });
    createAutomationJob({
      name: "禁用任务",
      prompt: "p",
      schedule: { type: "manual" },
      enabled: false,
    });

    const tools = createAutomationListTools({});
    const listTool = resolveTool(tools, "automation_list");

    const enabledResult = await callTool(listTool, { enabled: true }) as { jobs: Array<{ name: string }> };
    expect(enabledResult.jobs.length).toBe(1);
    expect(enabledResult.jobs[0]?.name).toBe("启用任务");

    const disabledResult = await callTool(listTool, { enabled: false }) as { jobs: Array<{ name: string }> };
    expect(disabledResult.jobs.length).toBe(1);
    expect(disabledResult.jobs[0]?.name).toBe("禁用任务");
  });

  test("scheduleType 应筛选调度类型", async () => {
    createAutomationJob({
      name: "cron任务",
      prompt: "p",
      schedule: { type: "cron", cronExpr: "0 9 * * *" },
      enabled: true,
    });
    createAutomationJob({
      name: "interval任务",
      prompt: "p",
      schedule: { type: "interval", intervalMs: 60000 },
      enabled: true,
    });

    const tools = createAutomationListTools({});
    const listTool = resolveTool(tools, "automation_list");
    const result = await callTool(listTool, { scheduleType: "cron" }) as { jobs: Array<{ name: string }> };
    expect(result.jobs.length).toBe(1);
    expect(result.jobs[0]?.name).toBe("cron任务");
  }, 30_000);

  test("limit 应限制返回数量", async () => {
    for (let i = 0; i < 5; i++) {
      createAutomationJob({
        name: `任务${i}`,
        prompt: "p",
        schedule: { type: "manual" },
        enabled: true,
      });
    }

    const tools = createAutomationListTools({});
    const listTool = resolveTool(tools, "automation_list");
    const result = await callTool(listTool, { limit: 3 }) as { total: number; jobs: unknown[] };
    expect(result.total).toBe(5);
    expect(result.jobs.length).toBe(3);
  });

  test("system 任务对 agent 工具面不可见(#647 follow-up1)", async () => {
    createAutomationJob({
      name: "系统蒸馏任务",
      prompt: "p",
      schedule: { type: "interval", intervalMs: 60000 },
      source: "system",
      systemAction: "memory_distill_workspace"
    });
    createAutomationJob({
      name: "用户任务",
      prompt: "p",
      schedule: { type: "interval", intervalMs: 60000 }
    });

    const tools = createAutomationListTools({});
    const result = await callTool(resolveTool(tools, "automation_list"), {}) as { jobs: Array<{ name: string }> };
    const names = result.jobs.map((job) => job.name);
    expect(names).toContain("用户任务");
    expect(names).not.toContain("系统蒸馏任务");
  });
});
