import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@lume/agent-sdk";
import type { AutomationSchedule, AutomationJob } from "@lume/shared";
import {
  createAutomationJob,
  deleteAutomationJob,
  listAutomationJobs,
  updateAutomationJob
} from "../../../automation/automation-manager";
import {
  listAutomationRuns,
  refreshAutomationRunnerJobs,
  runAutomationJobNow,
  startAutomationRunner
} from "../../../automation/automation-runner-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

interface CreateAutomationToolsInput {
  workspaceId?: string;
  sessionId?: string;
}

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

function isJobAccessible(job: AutomationJob, workspaceId?: string): boolean {
  if (!workspaceId) return true;
  return !job.workspaceId || job.workspaceId === workspaceId;
}

function resolveTargetJob(jobId: string, workspaceId?: string): AutomationJob {
  const target = listAutomationJobs().find((job) => job.id === jobId);
  if (!target) {
    throw new Error(`自动化任务不存在: ${jobId}`);
  }
  if (!isJobAccessible(target, workspaceId)) {
    throw new Error(`当前工作区无权操作该任务: ${jobId}`);
  }
  return target;
}

async function syncAutomationRunnerJobs(): Promise<void> {
  await startAutomationRunner();
  await refreshAutomationRunnerJobs();
}

function parseSchedule(raw: unknown): AutomationSchedule {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const typeRaw = asString(payload.type);
  if (!typeRaw || (typeRaw !== "cron" && typeRaw !== "once" && typeRaw !== "interval" && typeRaw !== "manual")) {
    throw new Error("schedule.type 必须是 cron | once | interval | manual");
  }
  return {
    type: typeRaw,
    ...(asString(payload.cronExpr) ? { cronExpr: asString(payload.cronExpr) } : {}),
    ...(asNumber(payload.runAt) ? { runAt: asNumber(payload.runAt) } : {}),
    ...(asNumber(payload.intervalMs) ? { intervalMs: asNumber(payload.intervalMs) } : {}),
    ...(asString(payload.timezone) ? { timezone: asString(payload.timezone) } : {})
  };
}

const PRESET_CRON_MAP: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekly: "0 9 * * 1",
  monthly: "0 9 1 * *"
};

const ReadSchema = Type.Object({
  workspaceId: Type.Optional(Type.String()),
  id: Type.Optional(Type.String())
});

const SetSchema = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("delete"),
    Type.Literal("enable"),
    Type.Literal("disable"),
    Type.Literal("run_now")
  ]),
  id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  workspaceId: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  schedule: Type.Optional(
    Type.Object({
      type: Type.Union([Type.Literal("cron"), Type.Literal("once"), Type.Literal("interval"), Type.Literal("manual")]),
      cronExpr: Type.Optional(Type.String()),
      runAt: Type.Optional(Type.Number()),
      intervalMs: Type.Optional(Type.Number()),
      timezone: Type.Optional(Type.String())
    })
  )
});

const QuerySchema = Type.Object({
  workspaceId: Type.Optional(Type.String()),
  jobId: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number())
});

export function createSdkCronTools(input: CreateAutomationToolsInput): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "automation_read",
      description: "读取自动化任务配置",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          id: { type: "string" }
        }
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(args) {
        const workspaceId = asString(args.workspaceId) ?? input.workspaceId;
        const id = asString(args.id);
        const jobs = listAutomationJobs().filter((job) => isJobAccessible(job, workspaceId));
        if (!id) {
          return { ok: true, total: jobs.length, jobs };
        }
        const target = jobs.find((job) => job.id === id);
        if (!target) {
          return { ok: false, error: `任务不存在或不可访问: ${id}` };
        }
        return { ok: true, job: target };
      }
    }),
    createSdkJsonResultTool({
      name: "automation_set",
      description: "设置自动化任务（创建/更新/删除/启停/立即执行），支持预设频率（hourly/daily/weekly/monthly）",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          id: { type: "string" },
          name: { type: "string" },
          prompt: { type: "string" },
          enabled: { type: "boolean" },
          workspaceId: { type: "string" },
          threadId: { type: "string" },
          schedule: { type: "object", properties: {} },
          preset: { type: "string", description: "预设频率: hourly | daily | weekly | monthly" },
        },
        required: ["action"]
      },
      async call(args) {
        const action = asString(args.action);
        const workspaceId = asString(args.workspaceId) ?? input.workspaceId;
        const threadId = asString(args.threadId) ?? input.sessionId;
        if (!action) throw new Error("action 必填");

        if (action === "create") {
          const name = asString(args.name);
          const prompt = asString(args.prompt);
          const preset = asString(args.preset);
          let scheduleRaw = args.schedule;
          if (preset && PRESET_CRON_MAP[preset]) {
            scheduleRaw = { type: "cron", cronExpr: PRESET_CRON_MAP[preset] };
          }
          const schedule = parseSchedule(scheduleRaw);
          if (!name) throw new Error("创建任务缺少 name");
          if (!prompt) throw new Error("创建任务缺少 prompt");
          const created = createAutomationJob({
            name,
            prompt,
            schedule,
            workspaceId,
            threadId,
            enabled: asBoolean(args.enabled)
          });
          await syncAutomationRunnerJobs();
          return { ok: true, action, job: created };
        }

        const id = asString(args.id);
        if (!id) throw new Error(`${action} 需要 id`);
        const target = resolveTargetJob(id, workspaceId);

        if (action === "delete") {
          const result = deleteAutomationJob({ id: target.id });
          await syncAutomationRunnerJobs();
          return { ok: true, action, result };
        }
        if (action === "enable" || action === "disable") {
          const updated = updateAutomationJob({ id: target.id, enabled: action === "enable" });
          await syncAutomationRunnerJobs();
          return { ok: true, action, job: updated };
        }
        if (action === "run_now") {
          void runAutomationJobNow({ id: target.id }).catch((error) => {
            console.error("[cron_set] run_now 触发失败:", error);
          });
          return {
            ok: true,
            action,
            accepted: true,
            message: "任务已触发（异步执行），请使用 cron_query 查询结果。"
          };
        }
        if (action === "update") {
          const nextThreadId = asString(args.threadId) ?? asString(args.sessionId);
          const updated = updateAutomationJob({
            id: target.id,
            ...(asString(args.name) ? { name: asString(args.name) } : {}),
            ...(asString(args.prompt) ? { prompt: asString(args.prompt) } : {}),
            ...(args.schedule ? { schedule: parseSchedule(args.schedule) } : {}),
            ...(nextThreadId ? { threadId: nextThreadId } : {}),
            ...(asBoolean(args.enabled) !== undefined ? { enabled: asBoolean(args.enabled) } : {})
          });
          await syncAutomationRunnerJobs();
          return { ok: true, action, job: updated };
        }
        throw new Error(`不支持的 action: ${action}`);
      }
    }),
    createSdkJsonResultTool({
      name: "automation_query",
      description: "查询自动化任务运行记录",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          jobId: { type: "string" },
          limit: { type: "number" }
        }
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call(args) {
        const workspaceId = asString(args.workspaceId) ?? input.workspaceId;
        const jobId = asString(args.jobId);
        const limit = asNumber(args.limit);
        const jobs = listAutomationJobs().filter((job) => isJobAccessible(job, workspaceId));
        const allowedJobIds = new Set(jobs.map((job) => job.id));
        if (jobId && !allowedJobIds.has(jobId)) {
          throw new Error(`任务不存在或不可访问: ${jobId}`);
        }
        const runs = listAutomationRuns({
          ...(jobId ? { jobId } : {}),
          ...(limit ? { limit } : {})
        }).filter((run) => allowedJobIds.has(run.jobId));
        return { ok: true, total: runs.length, runs };
      }
    })
  ];
}
