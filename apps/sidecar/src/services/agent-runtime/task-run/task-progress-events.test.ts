import { describe, expect, test } from "bun:test";
import { projectTaskRunEventToRuntimeEvent } from "./task-progress-events";
import type { TaskRun } from "./task-run-types";

describe("task-progress-events", () => {
  test("projects durable task run events into task.progress runtime events", () => {
    const taskRun: TaskRun = {
      id: "taskrun-1",
      contractId: "contract-1",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Ship task progress",
      summary: "Show task progress",
      status: "running",
      currentTaskId: "task-1",
      tasks: [{
        id: "task-1",
        title: "Patch",
        status: "running",
        attemptCount: 1
      }],
      events: [{
        type: "task_started",
        taskRunId: "taskrun-1",
        taskId: "task-1",
        createdAt: "2026-05-04T00:00:00.000Z"
      }],
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:00:00.000Z"
    };

    expect(projectTaskRunEventToRuntimeEvent("thread-1", taskRun, taskRun.events[0]!)).toMatchObject({
      id: "task.progress:taskrun-1:2026-05-04T00:00:00.000Z:task_started:task-1",
      type: "task.progress",
      threadId: "thread-1",
      runId: "run-1",
      taskRunId: "taskrun-1",
      contractId: "contract-1",
      status: "running",
      currentTaskId: "task-1",
      message: "开始执行：Patch"
    });
  });
});
