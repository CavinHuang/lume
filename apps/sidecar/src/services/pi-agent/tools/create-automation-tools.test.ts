import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createAutomationTools } from "./create-automation-tools";

function resolveTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`工具不存在: ${name}`);
  }
  return tool;
}

describe("create-automation-tools", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-automation-tools-"));
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

  test("应支持任务创建、读取、更新、删除", async () => {
    const tools = createAutomationTools({ workspaceId: "ws-1", sessionId: "session-main-1" }) as unknown as AgentTool[];
    const setTool = resolveTool(tools, "automation_timer_set");
    const readTool = resolveTool(tools, "automation_timer_read");

    const createResult = await setTool.execute("tool-call-create", {
      action: "create",
      name: "早报任务",
      prompt: "生成日报",
      schedule: { type: "cron", cronExpr: "30 8 * * 1-5" }
    }, new AbortController().signal);
    const createdJob = (createResult.details as { job?: { id?: string } }).job;
    expect(Boolean(createdJob?.id)).toBeTrue();
    const createdSessionId = (createResult.details as { job?: { sessionId?: string } }).job?.sessionId;
    expect(createdSessionId).toBe("session-main-1");

    const readResult = await readTool.execute("tool-call-read", {}, new AbortController().signal);
    const jobs = (readResult.details as { jobs?: Array<{ id: string; name: string }> }).jobs ?? [];
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.name).toBe("早报任务");

    const updateResult = await setTool.execute("tool-call-update", {
      action: "update",
      id: createdJob?.id,
      name: "早报任务-更新"
    }, new AbortController().signal);
    const updatedName = (updateResult.details as { job?: { name?: string } }).job?.name;
    expect(updatedName).toBe("早报任务-更新");

    const deleteResult = await setTool.execute("tool-call-delete", {
      action: "delete",
      id: createdJob?.id
    }, new AbortController().signal);
    expect((deleteResult.details as { ok?: boolean }).ok).toBeTrue();

    const readAfterDelete = await readTool.execute("tool-call-read-2", {}, new AbortController().signal);
    const jobsAfterDelete = (readAfterDelete.details as { jobs?: unknown[] }).jobs ?? [];
    expect(jobsAfterDelete.length).toBe(0);
  });

  test("query 应返回运行记录结构", async () => {
    const tools = createAutomationTools({ workspaceId: "ws-1" }) as unknown as AgentTool[];
    const queryTool = resolveTool(tools, "automation_timer_query");
    const result = await queryTool.execute("tool-call-query", { limit: 5 }, new AbortController().signal);
    const details = result.details as { ok?: boolean; runs?: unknown[] };
    expect(details.ok).toBeTrue();
    expect(Array.isArray(details.runs)).toBeTrue();
  });

  test("run_now 应异步触发并立即返回 accepted", async () => {
    const tools = createAutomationTools({ workspaceId: "ws-1", sessionId: "session-main-1" }) as unknown as AgentTool[];
    const setTool = resolveTool(tools, "automation_timer_set");

    const createResult = await setTool.execute("tool-call-create-run-now", {
      action: "create",
      name: "异步执行任务",
      prompt: "执行一次任务",
      schedule: { type: "interval", intervalMs: 60000 }
    }, new AbortController().signal);
    const createdId = (createResult.details as { job?: { id?: string } }).job?.id;
    expect(Boolean(createdId)).toBeTrue();

    const runNowResult = await setTool.execute("tool-call-run-now", {
      action: "run_now",
      id: createdId
    }, new AbortController().signal);
    const details = runNowResult.details as { ok?: boolean; accepted?: boolean; message?: string };
    expect(details.ok).toBeTrue();
    expect(details.accepted).toBeTrue();
    expect((details.message ?? "").includes("异步执行")).toBeTrue();
  });
});
