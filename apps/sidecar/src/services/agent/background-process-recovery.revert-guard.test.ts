import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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
import { stopRunningProcessJobsForCodingRun, stopRunningProcessJobsForThread, suppressCodingRunBackgroundNotifications } from "./background-process-recovery";

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

describe("stopRunningProcessJobsForThread", () => {
  test("stops all running jobs of the thread regardless of runId", async () => {
    clearProcessJobs();
    const root = await mkdtemp(join(tmpdir(), "lume-subagent-seal-"));
    const a = seedJob(root, "task_a", "run-1");
    const b = seedJob(root, "task_b", undefined);

    const stopped = stopRunningProcessJobsForThread("thread-1", "subagent run terminal", root);

    expect(stopped.map((job) => job.id).sort()).toEqual([a.id, b.id].sort());
    expect(getProcessJob(a.id)?.notified).toBe(true);
    expect(getProcessJob(b.id)?.notified).toBe(true);
  });
});

describe("suppressCodingRunBackgroundNotifications", () => {
  test("pre-consumes notification right of the reverted run's running jobs", async () => {
    clearProcessJobs();
    const root = await mkdtemp(join(tmpdir(), "lume-revert-suppress-"));
    const target = seedJob(root, "task_s1", "run-1");
    seedJob(root, "task_s2", "run-2");

    const suppressed = suppressCodingRunBackgroundNotifications("thread-1", "run-1", "test", root);

    expect(suppressed).toBe(1);
    expect(getProcessJob(target.id)?.notified).toBe(true);
    // 预消费后,后续 stop 守卫仍按 runId 精确停止(markNotified 不影响 stop 判定)
    const stopped = stopRunningProcessJobsForCodingRun("thread-1", "run-1", "test", root);
    expect(stopped.map((job) => job.id)).toEqual([target.id]);
  });
});

describe("sticky notified merge", () => {
  test("worker terminal write does not roll back consumed notification right", async () => {
    clearProcessJobs();
    const root = await mkdtemp(join(tmpdir(), "lume-revert-sticky-"));
    const job = seedJob(root, "task_t1", "run-1");
    updateProcessJob(job.id, { notified: true });

    // 模拟 worker 的读-合并-写:重写 state.json 丢弃 notified 并推进 updatedAt
    const statePath = join(root, job.id, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    delete state.notified;
    state.updatedAt = Date.now() + 5;
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

    expect(getProcessJob(job.id)?.notified).toBe(true);
  });
});
