import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import { createAutomationTemplateTools } from "./automation-template-tools";
import { listAutomationJobs } from "../../../automation/automation-manager";

function resolveTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  return tool;
}

async function callTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const result = await tool.call(input, { cwd: process.cwd(), abortSignal: new AbortController().signal });
  const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
  return (parsed.data ?? parsed) as Record<string, unknown>;
}

describe("automation-template-tools", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-automation-template-tools-"));
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

  test("list 应返回所有模板，包含通用和 routine 类型", async () => {
    const tools = createAutomationTemplateTools({});
    const templateTool = resolveTool(tools, "automation_template");

    const result = await callTool(templateTool, { action: "list" }) as {
      ok: boolean;
      templates: Array<{ templateId: string; category: string }>;
    };
    expect(result.ok).toBeTrue();
    expect(result.templates.length).toBeGreaterThanOrEqual(21);

    const categories = new Set(result.templates.map((t) => t.category));
    expect(categories.has("automation")).toBeTrue();
    expect(categories.has("routine")).toBeTrue();

    const ids = result.templates.map((t) => t.templateId);
    expect(ids).toContain("daily-bug-scan");
    expect(ids).toContain("routine-data-sync");
    expect(ids).toContain("routine-daily-summary");
  });

  test("create 应使用模板创建任务", async () => {
    const tools = createAutomationTemplateTools({});
    const templateTool = resolveTool(tools, "automation_template");

    const result = await callTool(templateTool, {
      action: "create",
      templateId: "daily-bug-scan",
      name: "我的自定义扫描任务",
    }) as { ok: boolean; action: string; job: { id?: string; name: string; prompt: string; source?: string } };

    expect(result.ok).toBeTrue();
    expect(result.action).toBe("create");
    expect(result.job.name).toBe("我的自定义扫描任务");
    expect(result.job.prompt).toContain("扫描");
    expect(result.job.source).toBe("manual");

    const allJobs = listAutomationJobs();
    const created = allJobs.find((j) => j.id === result.job.id);
    expect(created).toBeDefined();
    expect(created?.source).toBe("manual");
    expect(created?.schedule.type).toBe("cron");
    expect(created?.schedule.cronExpr).toBe("0 9 * * *");
  });

  test("create 应支持覆盖模板的 cron 表达式", async () => {
    const tools = createAutomationTemplateTools({});
    const templateTool = resolveTool(tools, "automation_template");

    const result = await callTool(templateTool, {
      action: "create",
      templateId: "standup-summary",
      cronExpr: "0 8 * * 1-5",
    }) as { ok: boolean; job: { schedule: { cronExpr?: string } } };

    expect(result.job.schedule.cronExpr).toBe("0 8 * * 1-5");
  });

  test("create 遇到不存在的 templateId 应报错", async () => {
    const tools = createAutomationTemplateTools({});
    const templateTool = resolveTool(tools, "automation_template");

    await expect(
      callTool(templateTool, { action: "create", templateId: "non-existent" })
    ).rejects.toThrow();
  });

  test("每个模板应有 templateId, name, description, prompt, schedule, category", async () => {
    const tools = createAutomationTemplateTools({});
    const templateTool = resolveTool(tools, "automation_template");

    const result = await callTool(templateTool, { action: "list" }) as {
      templates: Array<Record<string, unknown>>;
    };

    for (const tpl of result.templates) {
      expect(typeof tpl.templateId).toBe("string");
      expect(typeof tpl.name).toBe("string");
      expect(typeof tpl.description).toBe("string");
      expect(typeof tpl.prompt).toBe("string");
      expect(typeof tpl.schedule).toBe("object");
      expect(typeof tpl.category).toBe("string");
      expect(["automation", "routine"]).toContain(tpl.category as string);
    }
  });
});
