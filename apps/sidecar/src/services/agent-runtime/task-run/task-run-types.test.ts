import { describe, expect, test } from "bun:test";
import type { TaskContract } from "../plan/task-contract-types";
import type { TaskRun } from "./task-run-types";

describe("task-run types", () => {
  test("represent a task contract and the task run created from approval", () => {
    const contract: TaskContract = {
      id: "contract-1",
      runId: "run-1",
      threadId: "thread-1",
      goal: "Improve plan mode",
      summary: "Split approval contract from execution progress",
      tasks: [
        {
          id: "task-1",
          title: "Create task run types",
          description: "Define durable task run state",
          expectedFiles: ["apps/sidecar/src/services/agent-runtime/task-run/task-run-types.ts"]
        }
      ],
      risks: [
        { id: "risk-1", description: "Migration touches shared runtime state", severity: "medium" }
      ],
      expectedChanges: {
        files: ["packages/shared/src/types/agent.ts"]
      },
      status: "approved",
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:01:00.000Z",
      approvedAt: "2026-05-04T00:01:00.000Z"
    };

    const taskRun: TaskRun = {
      id: "task-run-1",
      contractId: contract.id,
      runId: contract.runId,
      threadId: contract.threadId,
      goal: contract.goal,
      summary: contract.summary,
      status: "pending",
      currentTaskId: undefined,
      tasks: contract.tasks.map((task) => ({
        ...task,
        status: "pending",
        attemptCount: 0
      })),
      events: [{
        type: "task_run_created",
        taskRunId: "task-run-1",
        contractId: contract.id,
        createdAt: "2026-05-04T00:01:00.000Z"
      }],
      createdAt: "2026-05-04T00:01:00.000Z",
      updatedAt: "2026-05-04T00:01:00.000Z"
    };

    expect(taskRun.contractId).toBe(contract.id);
    expect(taskRun.tasks[0]?.status).toBe("pending");
    expect(taskRun.events[0]?.type).toBe("task_run_created");
  });
});
