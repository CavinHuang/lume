import type { AgentSendInput } from "@lume/shared";
import type { TaskContract } from "../plan/task-contract-types";
import { createFileBackedTaskRunStore } from "./task-run-store";
import type { TaskRun, TaskRunEvent, TaskRunTask } from "./task-run-types";

export type TaskRunIntent = "execute" | "continue" | "retry" | "skip";

export interface StartedTaskRunTask {
  taskRun: TaskRun;
  task: TaskRunTask;
}

export function buildCurrentTaskRunSendInput(input: {
  threadId: string;
  taskRun: TaskRun;
  task: TaskRunTask;
  permissionMode?: AgentSendInput["permissionMode"];
  controlEvent?: "execute_task" | "continue_task" | "retry_task";
}): AgentSendInput {
  return {
    threadId: input.threadId,
    userMessage: [
      "请只执行当前任务，不要执行其它任务。",
      `TaskRun ID：${input.taskRun.id}`,
      `Task ID：${input.task.id}`,
      input.taskRun.summary ? `任务摘要：${input.taskRun.summary}` : "",
      `当前任务：${formatTaskText(input.task)}`,
      "完成、失败或被阻塞时，必须调用 TaskReport 写入结构化任务结果。",
      "不要只在普通回复里描述结果；没有 TaskReport 的运行会被视为该任务失败。"
    ].filter(Boolean).join("\n\n"),
    permissionMode: input.permissionMode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits",
    messageMetadata: {
      hiddenFromChat: true,
      taskControlEvent: input.controlEvent ?? "execute_task",
      taskRunId: input.taskRun.id,
      taskId: input.task.id
    }
  };
}

export async function createTaskRunFromContract(input: {
  sessionDir: string;
  contract: TaskContract;
  now?: () => string;
}): Promise<TaskRun> {
  const now = input.now ?? (() => new Date().toISOString());
  const timestamp = now();
  const store = createFileBackedTaskRunStore(input.sessionDir);
  const existing = await store.get(taskRunIdForContract(input.contract.id));
  if (existing) return existing;

  const taskRun: TaskRun = {
    id: taskRunIdForContract(input.contract.id),
    contractId: input.contract.id,
    runId: input.contract.runId,
    threadId: input.contract.threadId,
    goal: input.contract.goal,
    summary: input.contract.summary,
    status: "pending",
    currentTaskId: undefined,
    tasks: input.contract.tasks.map((task) => ({
      ...task,
      status: "pending",
      attemptCount: 0
    })),
    events: [{
      type: "task_run_created",
      taskRunId: taskRunIdForContract(input.contract.id),
      contractId: input.contract.id,
      createdAt: timestamp
    }],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await store.upsert(taskRun);
  return taskRun;
}

export async function startNextTaskRunTask(input: {
  sessionDir: string;
  threadId: string;
  taskRunId?: string;
  intent?: TaskRunIntent;
  now?: () => string;
}): Promise<StartedTaskRunTask | null> {
  if (input.intent === "skip") {
    await skipCurrentTask(input);
  }
  const store = createFileBackedTaskRunStore(input.sessionDir);
  const taskRun = await resolveTaskRun(store, input.threadId, input.taskRunId);
  if (!taskRun || !isTaskRunExecutable(taskRun)) return null;
  const task = selectNextTask(taskRun, input.intent ?? "execute");
  if (!task) {
    await completeTaskRunIfDone(input.sessionDir, taskRun, (input.now ?? (() => new Date().toISOString()))());
    return null;
  }

  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const tasks = taskRun.tasks.map((item) => (
    item.id === task.id
      ? {
          ...item,
          status: "running" as const,
          error: undefined,
          blockedReason: undefined,
          attemptCount: item.attemptCount + 1,
          startedAt: timestamp,
          endedAt: undefined
        }
      : item
  ));
  const saved: TaskRun = {
    ...taskRun,
    status: "running",
    currentTaskId: task.id,
    tasks,
    events: [
      ...taskRun.events,
      taskRunEvent("task_started", taskRun.id, timestamp, task.id)
    ],
    updatedAt: timestamp
  };
  await store.upsert(saved);
  return {
    taskRun: saved,
    task: saved.tasks.find((item) => item.id === task.id) ?? task
  };
}

export async function reportCurrentTask(input: {
  sessionDir: string;
  threadId: string;
  taskRunId?: string;
  taskId?: string;
  status: "completed" | "failed" | "blocked";
  message?: string;
  now?: () => string;
}): Promise<TaskRun | null> {
  const store = createFileBackedTaskRunStore(input.sessionDir);
  const taskRun = await resolveTaskRun(store, input.threadId, input.taskRunId);
  if (!taskRun || !taskRun.currentTaskId) return null;
  if (input.taskId && input.taskId !== taskRun.currentTaskId) {
    throw new Error("只能更新当前正在执行的任务");
  }
  const currentTask = taskRun.tasks.find((task) => task.id === taskRun.currentTaskId);
  if (!currentTask || currentTask.status !== "running") {
    throw new Error("只能更新当前正在执行的任务");
  }
  if (input.status === "blocked") {
    return markTaskRunWaiting({
      sessionDir: input.sessionDir,
      threadId: input.threadId,
      taskRunId: taskRun.id,
      waitingFor: "user",
      reason: input.message ?? "任务被阻塞",
      now: input.now
    });
  }

  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const taskStatus = input.status === "completed" ? "completed" : "failed";
  const tasks = taskRun.tasks.map((task) => (
    task.id === currentTask.id
      ? {
          ...task,
          status: taskStatus,
          result: input.status === "completed" ? input.message : task.result,
          error: input.status === "failed" ? input.message : undefined,
          blockedReason: undefined,
          endedAt: timestamp
        } satisfies TaskRunTask
      : task
  ));
  const hasRemaining = tasks.some((task) => task.status === "pending" || task.status === "failed");
  const nextStatus = input.status === "failed" ? "failed" : hasRemaining ? "pending" : "completed";
  const saved: TaskRun = {
    ...taskRun,
    status: nextStatus,
    currentTaskId: input.status === "failed" ? currentTask.id : undefined,
    tasks,
    events: [
      ...taskRun.events,
      taskRunEvent(input.status === "completed" ? "task_completed" : "task_failed", taskRun.id, timestamp, currentTask.id, input.message),
      ...(nextStatus === "completed" ? [taskRunEvent("task_run_completed", taskRun.id, timestamp)] : [])
    ],
    updatedAt: timestamp,
    ...(nextStatus === "completed" ? { completedAt: timestamp } : {})
  };
  await store.upsert(saved);
  return saved;
}

export async function markCurrentTaskUnreported(input: {
  sessionDir: string;
  threadId: string;
  taskRunId?: string;
  now?: () => string;
}): Promise<TaskRun | null> {
  return reportCurrentTask({
    ...input,
    status: "failed",
    message: "任务未提交结构化结果"
  });
}

export async function markTaskRunWaiting(input: {
  sessionDir: string;
  threadId: string;
  taskRunId?: string;
  waitingFor: "user" | "permission";
  reason?: string;
  now?: () => string;
}): Promise<TaskRun | null> {
  const store = createFileBackedTaskRunStore(input.sessionDir);
  const taskRun = await resolveTaskRun(store, input.threadId, input.taskRunId);
  if (!taskRun || !taskRun.currentTaskId) return null;
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const tasks = taskRun.tasks.map((task) => (
    task.id === taskRun.currentTaskId
      ? { ...task, blockedReason: input.reason }
      : task
  ));
  const saved: TaskRun = {
    ...taskRun,
    status: input.waitingFor === "permission" ? "waiting_for_permission" : "waiting_for_user",
    tasks,
    events: [
      ...taskRun.events,
      taskRunEvent("task_waiting", taskRun.id, timestamp, taskRun.currentTaskId, input.reason)
    ],
    updatedAt: timestamp
  };
  await store.upsert(saved);
  return saved;
}

export async function skipCurrentTask(input: {
  sessionDir: string;
  threadId: string;
  taskRunId?: string;
  now?: () => string;
}): Promise<TaskRun | null> {
  const store = createFileBackedTaskRunStore(input.sessionDir);
  const taskRun = await resolveTaskRun(store, input.threadId, input.taskRunId);
  if (!taskRun) return null;
  const task = taskRun.currentTaskId
    ? taskRun.tasks.find((item) => item.id === taskRun.currentTaskId)
    : taskRun.tasks.find((item) => item.status === "failed" || item.status === "pending");
  if (!task || task.status === "running" || task.status === "completed" || task.status === "skipped") {
    return null;
  }
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const tasks = taskRun.tasks.map((item) => (
    item.id === task.id
      ? { ...item, status: "skipped" as const, error: undefined, endedAt: timestamp }
      : item
  ));
  const nextStatus = tasks.every((item) => item.status === "completed" || item.status === "skipped")
    ? "completed"
    : "pending";
  const saved: TaskRun = {
    ...taskRun,
    status: nextStatus,
    currentTaskId: undefined,
    tasks,
    events: [
      ...taskRun.events,
      taskRunEvent("task_skipped", taskRun.id, timestamp, task.id, "已跳过任务"),
      ...(nextStatus === "completed" ? [taskRunEvent("task_run_completed", taskRun.id, timestamp)] : [])
    ],
    updatedAt: timestamp,
    ...(nextStatus === "completed" ? { completedAt: timestamp } : {})
  };
  await store.upsert(saved);
  return saved;
}

function taskRunIdForContract(contractId: string): string {
  return `taskrun-${contractId}`;
}

async function resolveTaskRun(
  store: ReturnType<typeof createFileBackedTaskRunStore>,
  threadId: string,
  taskRunId?: string
): Promise<TaskRun | null> {
  if (taskRunId) {
    const taskRun = await store.get(taskRunId);
    return taskRun?.threadId === threadId ? taskRun : null;
  }
  return (await store.listByThread(threadId))
    .filter((item) => item.tasks.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

function isTaskRunExecutable(taskRun: TaskRun): boolean {
  return taskRun.status === "pending" || taskRun.status === "running" || taskRun.status === "failed";
}

function selectNextTask(taskRun: TaskRun, intent: TaskRunIntent): TaskRunTask | null {
  if (intent === "retry" && taskRun.currentTaskId) {
    const current = taskRun.tasks.find((task) => task.id === taskRun.currentTaskId);
    if (current?.status === "failed") return current;
  }
  if (taskRun.currentTaskId) {
    const current = taskRun.tasks.find((task) => task.id === taskRun.currentTaskId);
    if (current?.status === "running") return current;
  }
  return taskRun.tasks.find((task) => task.status === "pending" || task.status === "failed") ?? null;
}

async function completeTaskRunIfDone(sessionDir: string, taskRun: TaskRun, timestamp: string): Promise<TaskRun | null> {
  if (!taskRun.tasks.every((task) => task.status === "completed" || task.status === "skipped")) return null;
  const store = createFileBackedTaskRunStore(sessionDir);
  const saved: TaskRun = {
    ...taskRun,
    status: "completed",
    currentTaskId: undefined,
    events: [...taskRun.events, taskRunEvent("task_run_completed", taskRun.id, timestamp)],
    updatedAt: timestamp,
    completedAt: timestamp
  };
  await store.upsert(saved);
  return saved;
}

function taskRunEvent(
  type: TaskRunEvent["type"],
  taskRunId: string,
  createdAt: string,
  taskId?: string,
  message?: string
): TaskRunEvent {
  return {
    type,
    taskRunId,
    ...(taskId ? { taskId } : {}),
    ...(message ? { message } : {}),
    createdAt
  };
}

function formatTaskText(task: TaskRunTask): string {
  return task.title || task.description || `执行任务 ${task.id}`;
}
