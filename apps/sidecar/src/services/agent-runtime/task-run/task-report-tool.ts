import { defineTool, type ToolDefinition } from "@lume/agent-sdk";
import { reportCurrentTask } from "./task-run-controller";

export interface CreateTaskReportToolInput {
  sessionDir: string;
  threadId: string;
  now?: () => string;
  onTaskRunUpdated?: () => void | Promise<void>;
}

export function createTaskReportTool(input: CreateTaskReportToolInput): ToolDefinition {
  return defineTool({
    name: "TaskReport",
    description: "Report the structured result for the current running Lume task.",
    inputSchema: {
      type: "object",
      properties: {
        taskRunId: { type: "string" },
        taskId: { type: "string" },
        status: { type: "string", enum: ["completed", "failed", "blocked"] },
        result: { type: "string" },
        error: { type: "string" }
      },
      required: ["taskRunId", "taskId", "status"]
    },
    isReadOnly: true,
    isConcurrencySafe: false,
    async call(rawInput) {
      const record = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
      const taskRunId = toNonEmptyString(record.taskRunId);
      const taskId = toNonEmptyString(record.taskId);
      const status = normalizeStatus(record.status);
      if (!taskRunId || !taskId || !status) {
        throw new Error("TaskReport 需要 taskRunId、taskId 和有效 status");
      }
      const message = status === "failed"
        ? toNonEmptyString(record.error) ?? toNonEmptyString(record.result)
        : toNonEmptyString(record.result) ?? toNonEmptyString(record.error);
      const taskRun = await reportCurrentTask({
        sessionDir: input.sessionDir,
        threadId: input.threadId,
        taskRunId,
        taskId,
        status,
        message,
        now: input.now
      });
      if (!taskRun) {
        throw new Error("找不到可更新的当前任务");
      }
      await input.onTaskRunUpdated?.();
      return {
        data: {
          ok: true,
          taskRunId,
          taskId,
          status
        }
      };
    }
  });
}

function normalizeStatus(value: unknown): "completed" | "failed" | "blocked" | undefined {
  return value === "completed" || value === "failed" || value === "blocked" ? value : undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
