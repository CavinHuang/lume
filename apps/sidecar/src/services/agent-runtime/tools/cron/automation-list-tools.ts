import type { ToolDefinition } from "@lume/agent-sdk";
import { listAutomationJobs } from "../../../automation/automation-manager";
import { createSdkJsonResultTool } from "../sdk-tool-result";
import { isJobAccessible } from "./cron-job-access";

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createAutomationListTools(_input: { workspaceId?: string }): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "automation_list",
      description: "搜索和筛选已有自动化任务。支持按名称模糊匹配、启用状态、调度类型、近期执行记录筛选。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "名称模糊匹配（中文）" },
          enabled: { type: "boolean", description: "按启用状态筛选" },
          scheduleType: { type: "string", description: "调度类型: cron | once | interval | manual" },
          hasRecentRun: { type: "boolean", description: "最近 7 天内是否有执行记录" },
          limit: { type: "number", description: "返回数量上限，默认 50，最大 200" },
        },
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(input) {
        const workspaceId = _input.workspaceId;
        const query = asString(input.query);
        const enabledFilter = asBoolean(input.enabled);
        const scheduleType = asString(input.scheduleType);
        const hasRecentRun = asBoolean(input.hasRecentRun);
        const limit = Math.min(asNumber(input.limit) ?? 50, 200);

        const sevenDaysAgo = Date.now() - 7 * 86400_000;

        let jobs = listAutomationJobs().filter((job) => isJobAccessible(job, workspaceId));

        if (query) {
          jobs = jobs.filter((job) => job.name.includes(query));
        }
        if (enabledFilter !== undefined) {
          jobs = jobs.filter((job) => job.enabled === enabledFilter);
        }
        if (scheduleType) {
          jobs = jobs.filter((job) => job.schedule.type === scheduleType);
        }
        if (hasRecentRun) {
          jobs = jobs.filter((job) => job.lastRunAt !== undefined && job.lastRunAt >= sevenDaysAgo);
        }

        return { ok: true, total: jobs.length, jobs: jobs.slice(0, limit) };
      },
    }),
  ];
}
