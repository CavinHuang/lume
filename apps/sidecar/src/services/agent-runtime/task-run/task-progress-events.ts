import type { LumeRunEvent } from "@lume/shared";
import type { TaskRun, TaskRunEvent } from "./task-run-types";

export function projectTaskRunEventToProgressEvent(
  taskRun: TaskRun,
  event: TaskRunEvent
): Extract<LumeRunEvent, { type: "task_progress" }> {
  return {
    type: "task_progress",
    taskRunId: taskRun.id,
    contractId: taskRun.contractId,
    status: taskRun.status,
    ...(taskRun.currentTaskId ? { currentTaskId: taskRun.currentTaskId } : {}),
    tasks: taskRun.tasks,
    message: event.message ?? defaultTaskProgressMessage(taskRun, event),
    createdAt: event.createdAt
  };
}

export function projectTaskRunToProgressEvents(taskRun: TaskRun): Array<Extract<LumeRunEvent, { type: "task_progress" }>> {
  return taskRun.events.map((event) => projectTaskRunEventToProgressEvent(taskRun, event));
}

function defaultTaskProgressMessage(taskRun: TaskRun, event: TaskRunEvent): string {
  const task = event.taskId ? taskRun.tasks.find((item) => item.id === event.taskId) : undefined;
  const title = task?.title ?? "任务";
  switch (event.type) {
    case "task_run_created":
      return "任务进度已创建";
    case "task_started":
      return `开始执行：${title}`;
    case "task_completed":
      return `已完成：${title}`;
    case "task_failed":
      return `执行失败：${title}`;
    case "task_skipped":
      return `已跳过：${title}`;
    case "task_waiting":
      return `等待确认：${title}`;
    case "task_run_completed":
      return "任务已全部完成";
  }
}
