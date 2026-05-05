import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskContract } from "../plan/task-contract-types";
import {
  buildCurrentTaskRunSendInput,
  createTaskRunFromContract,
  markCurrentTaskUnreported,
  markTaskRunWaiting,
  reportCurrentTask,
  skipCurrentTask,
  startNextTaskRunTask
} from "./task-run-controller";
import { createFileBackedTaskRunStore } from "./task-run-store";

describe("task-run-controller", () => {
  test("creates a task run from an approved task contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-run-create-"));

    const taskRun = await createTaskRunFromContract({
      sessionDir: dir,
      contract: approvedContract(),
      now: () => "2026-05-04T00:02:00.000Z"
    });

    expect(taskRun).toMatchObject({
      contractId: "contract-1",
      status: "pending",
      tasks: [
        { id: "task-1", status: "pending", attemptCount: 0 },
        { id: "task-2", status: "pending", attemptCount: 0 }
      ],
      events: [{ type: "task_run_created", taskRunId: "taskrun-contract-1" }]
    });
    expect(await createFileBackedTaskRunStore(dir).get("taskrun-contract-1")).toMatchObject({
      contractId: "contract-1"
    });
  });

  test("starts only the current task and builds an acceptEdits hidden input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-run-start-"));
    await createTaskRunFromContract({
      sessionDir: dir,
      contract: approvedContract(),
      now: () => "2026-05-04T00:02:00.000Z"
    });

    const started = await startNextTaskRunTask({
      sessionDir: dir,
      threadId: "thread-1",
      taskRunId: "taskrun-contract-1",
      now: () => "2026-05-04T00:03:00.000Z"
    });

    expect(started?.task.id).toBe("task-1");
    expect(await createFileBackedTaskRunStore(dir).get("taskrun-contract-1")).toMatchObject({
      status: "running",
      currentTaskId: "task-1",
      tasks: [
        { id: "task-1", status: "running", attemptCount: 1, startedAt: "2026-05-04T00:03:00.000Z" },
        { id: "task-2", status: "pending" }
      ],
      events: [
        { type: "task_run_created" },
        { type: "task_started", taskRunId: "taskrun-contract-1", taskId: "task-1" }
      ]
    });
    expect(buildCurrentTaskRunSendInput({
      threadId: "thread-1",
      taskRun: started!.taskRun,
      task: started!.task
    })).toMatchObject({
      permissionMode: "acceptEdits",
      messageMetadata: {
        hiddenFromChat: true,
        taskRunId: "taskrun-contract-1",
        taskId: "task-1",
        taskControlEvent: "execute_task"
      }
    });
  });

  test("completed task returns the run to pending until the next task starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-run-complete-"));
    await createStartedRun(dir);

    await reportCurrentTask({
      sessionDir: dir,
      threadId: "thread-1",
      taskRunId: "taskrun-contract-1",
      taskId: "task-1",
      status: "completed",
      message: "Types added",
      now: () => "2026-05-04T00:04:00.000Z"
    });

    expect(await createFileBackedTaskRunStore(dir).get("taskrun-contract-1")).toMatchObject({
      status: "pending",
      tasks: [
        { id: "task-1", status: "completed", result: "Types added", endedAt: "2026-05-04T00:04:00.000Z" },
        { id: "task-2", status: "pending" }
      ],
      events: [
        { type: "task_run_created" },
        { type: "task_started" },
        { type: "task_completed", taskId: "task-1", message: "Types added" }
      ]
    });
  });

  test("marks current task failed when a run completes without TaskReport", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-run-unreported-"));
    await createStartedRun(dir);

    await markCurrentTaskUnreported({
      sessionDir: dir,
      threadId: "thread-1",
      taskRunId: "taskrun-contract-1",
      now: () => "2026-05-04T00:05:00.000Z"
    });

    expect(await createFileBackedTaskRunStore(dir).get("taskrun-contract-1")).toMatchObject({
      status: "failed",
      currentTaskId: "task-1",
      tasks: [
        { id: "task-1", status: "failed", error: "任务未提交结构化结果" },
        { id: "task-2", status: "pending" }
      ],
      events: [
        { type: "task_run_created" },
        { type: "task_started" },
        { type: "task_failed", taskId: "task-1", message: "任务未提交结构化结果" }
      ]
    });
  });

  test("skip only applies to failed or pending tasks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-run-skip-"));
    await createStartedRun(dir);
    expect(await skipCurrentTask({ sessionDir: dir, threadId: "thread-1", taskRunId: "taskrun-contract-1" })).toBeNull();

    await markCurrentTaskUnreported({
      sessionDir: dir,
      threadId: "thread-1",
      taskRunId: "taskrun-contract-1",
      now: () => "2026-05-04T00:05:00.000Z"
    });
    await skipCurrentTask({
      sessionDir: dir,
      threadId: "thread-1",
      taskRunId: "taskrun-contract-1",
      now: () => "2026-05-04T00:06:00.000Z"
    });

    expect(await createFileBackedTaskRunStore(dir).get("taskrun-contract-1")).toMatchObject({
      status: "pending",
      tasks: [
        { id: "task-1", status: "skipped" },
        { id: "task-2", status: "pending" }
      ],
      events: [
        { type: "task_run_created" },
        { type: "task_started" },
        { type: "task_failed" },
        { type: "task_skipped", taskId: "task-1" }
      ]
    });
  });

  test("blocked task marks the run waiting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-run-waiting-"));
    await createStartedRun(dir);

    await markTaskRunWaiting({
      sessionDir: dir,
      threadId: "thread-1",
      taskRunId: "taskrun-contract-1",
      waitingFor: "permission",
      reason: "需要运行测试",
      now: () => "2026-05-04T00:07:00.000Z"
    });

    expect(await createFileBackedTaskRunStore(dir).get("taskrun-contract-1")).toMatchObject({
      status: "waiting_for_permission",
      currentTaskId: "task-1",
      tasks: [
        { id: "task-1", status: "running", blockedReason: "需要运行测试" },
        { id: "task-2", status: "pending" }
      ],
      events: [
        { type: "task_run_created" },
        { type: "task_started" },
        { type: "task_waiting", taskId: "task-1", message: "需要运行测试" }
      ]
    });
  });
});

function approvedContract(): TaskContract {
  return {
    id: "contract-1",
    runId: "run-1",
    threadId: "thread-1",
    goal: "Improve plan mode",
    summary: "Split approval contract from execution progress",
    tasks: [
      { id: "task-1", title: "Create types", description: "Create types" },
      { id: "task-2", title: "Wire controller", description: "Wire controller" }
    ],
    risks: [],
    expectedChanges: {},
    status: "approved",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:01:00.000Z",
    approvedAt: "2026-05-04T00:01:00.000Z"
  };
}

async function createStartedRun(sessionDir: string): Promise<void> {
  await createTaskRunFromContract({
    sessionDir,
    contract: approvedContract(),
    now: () => "2026-05-04T00:02:00.000Z"
  });
  await startNextTaskRunTask({
    sessionDir,
    threadId: "thread-1",
    taskRunId: "taskrun-contract-1",
    now: () => "2026-05-04T00:03:00.000Z"
  });
}
