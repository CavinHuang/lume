import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AutomationSchedule, AutomationJob } from "@lume/shared";
import {
  createAutomationJob,
  deleteAutomationJob,
  listAutomationJobs,
  updateAutomationJob
} from "../../automation-manager";
import { listAutomationRuns, runAutomationJobNow } from "../../automation-runner-service";

interface CreateAutomationToolsInput {
  workspaceId?: string;
  sessionId?: string;
}

function toResult<TDetails>(details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(details, null, 2)
      }
    ],
    details
  };
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

function parseSchedule(raw: unknown): AutomationSchedule {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const typeRaw = asString(payload.type);
  if (!typeRaw || (typeRaw !== "cron" && typeRaw !== "once" && typeRaw !== "interval")) {
    throw new Error("schedule.type 必须是 cron | once | interval");
  }
  return {
    type: typeRaw,
    ...(asString(payload.cronExpr) ? { cronExpr: asString(payload.cronExpr) } : {}),
    ...(asNumber(payload.runAt) ? { runAt: asNumber(payload.runAt) } : {}),
    ...(asNumber(payload.intervalMs) ? { intervalMs: asNumber(payload.intervalMs) } : {}),
    ...(asString(payload.timezone) ? { timezone: asString(payload.timezone) } : {})
  };
}

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
      type: Type.Union([Type.Literal("cron"), Type.Literal("once"), Type.Literal("interval")]),
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

export function createAutomationTools(input: CreateAutomationToolsInput): AgentTool[] {
  return [
    {
      name: "automation_timer_read",
      label: "AutomationTimerRead",
      description: "读取定时任务配置（读取）",
      parameters: ReadSchema,
      async execute(_toolCallId, args) {
        try {
          const params = (args ?? {}) as Record<string, unknown>;
          const workspaceId = asString(params.workspaceId) ?? input.workspaceId;
          const id = asString(params.id);
          const jobs = listAutomationJobs().filter((job) => isJobAccessible(job, workspaceId));
          if (!id) {
            return toResult({
              ok: true,
              total: jobs.length,
              jobs
            });
          }
          const target = jobs.find((job) => job.id === id);
          if (!target) {
            return toResult({
              ok: false,
              error: `任务不存在或不可访问: ${id}`
            });
          }
          return toResult({
            ok: true,
            job: target
          });
        } catch (error) {
          return toResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    },
    {
      name: "automation_timer_set",
      label: "AutomationTimerSet",
      description: "设置定时任务（创建/更新/删除/启停/立即执行）",
      parameters: SetSchema,
      async execute(_toolCallId, args) {
        try {
          const params = (args ?? {}) as Record<string, unknown>;
          const action = asString(params.action);
          const workspaceId = asString(params.workspaceId) ?? input.workspaceId;
          const sessionId = asString(params.sessionId) ?? input.sessionId;
          if (!action) throw new Error("action 必填");

          if (action === "create") {
            const name = asString(params.name);
            const prompt = asString(params.prompt);
            const schedule = parseSchedule(params.schedule);
            if (!name) throw new Error("创建任务缺少 name");
            if (!prompt) throw new Error("创建任务缺少 prompt");
            const created = createAutomationJob({
              name,
              prompt,
              schedule,
              workspaceId,
              sessionId,
              enabled: asBoolean(params.enabled)
            });
            return toResult({ ok: true, action, job: created });
          }

          const id = asString(params.id);
          if (!id) throw new Error(`${action} 需要 id`);
          const target = resolveTargetJob(id, workspaceId);

          if (action === "delete") {
            const result = deleteAutomationJob({ id: target.id });
            return toResult({ ok: true, action, result });
          }

          if (action === "enable" || action === "disable") {
            const updated = updateAutomationJob({ id: target.id, enabled: action === "enable" });
            return toResult({ ok: true, action, job: updated });
          }

          if (action === "run_now") {
            void runAutomationJobNow({ id: target.id }).catch((error) => {
              console.error("[automation_timer_set] run_now 触发失败:", error);
            });
            return toResult({
              ok: true,
              action,
              accepted: true,
              message: "任务已触发（异步执行），请使用 automation_timer_query 查询结果。"
            });
          }

          if (action === "update") {
            const updated = updateAutomationJob({
              id: target.id,
              ...(asString(params.name) ? { name: asString(params.name) } : {}),
              ...(asString(params.prompt) ? { prompt: asString(params.prompt) } : {}),
              ...(params.schedule ? { schedule: parseSchedule(params.schedule) } : {}),
              ...(asString(params.sessionId) ? { sessionId: asString(params.sessionId) } : {}),
              ...(asBoolean(params.enabled) !== undefined ? { enabled: asBoolean(params.enabled) } : {})
            });
            return toResult({ ok: true, action, job: updated });
          }

          throw new Error(`不支持的 action: ${action}`);
        } catch (error) {
          return toResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    },
    {
      name: "automation_timer_query",
      label: "AutomationTimerQuery",
      description: "查询定时任务运行记录（查询）",
      parameters: QuerySchema,
      async execute(_toolCallId, args) {
        try {
          const params = (args ?? {}) as Record<string, unknown>;
          const workspaceId = asString(params.workspaceId) ?? input.workspaceId;
          const jobId = asString(params.jobId);
          const limit = asNumber(params.limit);
          const jobs = listAutomationJobs().filter((job) => isJobAccessible(job, workspaceId));
          const allowedJobIds = new Set(jobs.map((job) => job.id));
          if (jobId && !allowedJobIds.has(jobId)) {
            throw new Error(`任务不存在或不可访问: ${jobId}`);
          }
          const runs = listAutomationRuns({
            ...(jobId ? { jobId } : {}),
            ...(limit ? { limit } : {})
          }).filter((run) => allowedJobIds.has(run.jobId));
          return toResult({
            ok: true,
            total: runs.length,
            runs
          });
        } catch (error) {
          return toResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  ];
}
