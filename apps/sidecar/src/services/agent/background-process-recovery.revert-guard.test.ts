import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProcessJobs,
  createProcessJobRecord,
  getProcessJob,
  updateProcessJob,
  type ProcessJob,
} from "@lume/agent-sdk";
import { stopRunningProcessJobsForCodingRun } from "./background-process-recovery";

function runningExecution(): Record<string, unknown> {
  return {
    version: 2,
    outcome: "running",
    terminationReason: "running",
    durationMs: 0,
    command: "sleep 30",
    shell: "bash",
    resultRef: { kind: "file", path: "out.log", size: 0, mimeType: "text/plain" },
  };
}

function seedJob(root: string, id: string, runId: string | undefined, status: ProcessJobStatus = "running"): ProcessJob {
  return createProcessJobRecord({
    id,
    subject: id,
    status,
    threadId: "thread-1",
    runId,
    // 探活需要活进程且无 workerIdentity 即视为存活——用测试进程自身 pid
    workerPid: process.pid,
    jobDir: join(root, id),
    taskType: "shell",
    metadata: { execution: runningExecution() },
  });
}

type ProcessJobStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

describe("stopRunningProcessJobsForCodingRun", () => {
  test("stops only the reverted run's running jobs and consumes their notification right", async () => {
    clearProcessJobs();
    const root = await mkdtemp(join(tmpdir(), "lume-revert-guard-"));
    const target = seedJob(root, "task_1", "run-1");
    const otherRun = seedJob(root, "task_2", "run-2");
    const alreadyDone = seedJob(root, "task_3", "run-1", "completed");

    const stopped = stopRunningProcessJobsForCodingRun("thread-1", "run-1", "test", root);

    expect(stopped.map((job) => job.id)).toEqual([target.id]);
    const targetAfter = getProcessJob(target.id)!;
    expect(targetAfter.status).toBe("stopped");
    expect(targetAfter.notified).toBe(true);
    expect(targetAfter.metadata?.execution).toMatchObject({ outcome: "cancelled", terminationReason: "aborted" });
    // 其他 Run 的任务不受影响
    expect(getProcessJob(otherRun.id)?.status).toBe("running");
    expect(getProcessJob(otherRun.id)?.notified).toBeUndefined();
    // 已终态任务不在处理范围
    expect(getProcessJob(alreadyDone.id)?.status).toBe("completed");
  });

  test("treats jobs without runId as out of scope", async () => {
    clearProcessJobs();
    const root = await mkdtemp(join(tmpdir(), "lume-revert-guard-2-"));
    seedJob(root, "task_4", undefined);

    const stopped = stopRunningProcessJobsForCodingRun("thread-1", "run-1", "test", root);

    expect(stopped).toEqual([]);
    expect(getProcessJob("task_4")?.status).toBe("running");
    // 恢复注册表,避免污染其他用例
    updateProcessJob("task_4", { status: "completed" });
  });
});
