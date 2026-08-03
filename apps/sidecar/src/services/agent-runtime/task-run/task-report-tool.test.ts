import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskContract } from "../plan/task-contract-types";
import {
  createTaskRunFromContract,
  startNextTaskRunTask
} from "./task-run-controller";
import { createTaskReportTool } from "./task-report-tool";
import { createFileBackedTaskRunStore } from "./task-run-store";

describe("TaskReportTool", () => {
  test("completes only the current running task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-report-"));
    await createStartedRun(dir);
    const tool = createTaskReportTool({
      sessionDir: dir,
      threadId: "thread-1",
      now: () => "2026-05-04T00:04:00.000Z"
    });

    const result = await tool.call({
      taskRunId: "taskrun-contract-1",
      taskId: "task-1",
      status: "completed",
      result: "Types are ready"
    }, {} as any);

    expect(JSON.parse(String(result.content))).toEqual({
      ok: true,
      taskRunId: "taskrun-contract-1",
      taskId: "task-1",
      status: "completed"
    });
    expect(await createFileBackedTaskRunStore(dir).get("taskrun-contract-1")).toMatchObject({
      status: "pending",
      tasks: [
        { id: "task-1", status: "completed", result: "Types are ready" },
        { id: "task-2", status: "pending" }
      ],
      events: [
        { type: "task_run_created" },
        { type: "task_started" },
        { type: "task_completed", taskId: "task-1", message: "Types are ready" }
      ]
    });
  });

  test("rejects attempts to report a non-current task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-task-report-reject-"));
    await createStartedRun(dir);
    const tool = createTaskReportTool({
      sessionDir: dir,
      threadId: "thread-1"
    });

    const result = await tool.call({
      taskRunId: "taskrun-contract-1",
      taskId: "task-2",
      status: "completed",
      result: "Skipped ahead"
    }, {} as any);

    expect(result).toMatchObject({
      is_error: true,
      content: expect.stringContaining("只能更新当前正在执行的任务")
    });
  });
});

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
