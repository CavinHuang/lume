import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkEventEnvelope } from "@lume/shared";
import { getThreadEventBus } from "../events/thread-event-bus";
import { getRuntimeCoreSessionDir } from "./session-store";
import { publishBackgroundTaskNotificationToBus } from "./run";

function lateNotification(fields: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "job-1",
    status: "completed",
    session_id: "s1",
    ...fields
  };
}

function isBackgroundTaskDetail(detail: unknown): boolean {
  return (detail as { type?: string } | null)?.type === "background.task";
}

describe("run.ts handleAsyncEvent 旁路注入(late task_notification → background.task 总线事件)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(threadId: string): { sessionDir: string; published: SdkEventEnvelope[] } {
    const agentDir = mkdtempSync(join(tmpdir(), "run-task-bus-"));
    dirs.push(agentDir);
    const sessionDir = getRuntimeCoreSessionDir(threadId, agentDir);
    const published: SdkEventEnvelope[] = [];
    getThreadEventBus(sessionDir).subscribe(threadId, (envelope) => {
      if (isBackgroundTaskDetail(envelope.detail)) published.push(envelope);
    });
    return { sessionDir, published };
  }

  test("四态终态主流通知 → publish 与 projector 主流版同形态的 detail,seq 单调", async () => {
    const threadId = "run-task-bus-on";
    const { sessionDir, published } = setup(threadId);

    publishBackgroundTaskNotificationToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      event: lateNotification({
        message: "Task finished",
        summary: "did things",
        execution: { durationMs: 12 }
      }) as never
    });

    expect(published).toHaveLength(1);
    const envelope = published[0]!;
    expect(envelope.kind).toBe("run");
    expect(envelope.phase).toBe("event");
    expect(envelope.turnId).toBeNull();
    expect(envelope.threadId).toBe(threadId);
    expect(envelope.runId).toBe("lume-run-1");
    expect(envelope.detail).toEqual({
      type: "background.task",
      taskId: "job-1",
      status: "completed",
      message: "Task finished",
      summary: "did things",
      execution: { durationMs: 12 }
    });

    // killed 别名 → stopped;同一 bus seq 单调递增(双入口归一的前提)
    publishBackgroundTaskNotificationToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      event: lateNotification({ task_id: "job-2", status: "killed" }) as never
    });
    expect(published).toHaveLength(2);
    expect((published[1]!.detail as { status: string }).status).toBe("stopped");
    expect(published[1]!.seq).toBeGreaterThan(published[0]!.seq);

    // 持久化:events.jsonl 落盘(持久化即承诺)
    expect(await getThreadEventBus(sessionDir).read(threadId))
      .toContainEqual(expect.objectContaining({
        kind: "run",
        phase: "event",
        detail: expect.objectContaining({ type: "background.task", taskId: "job-1" })
      }));
  });

  test("subagent 形态(subagent_run_id)不注入——子代理事件走各自会话", async () => {
    const threadId = "run-task-bus-subagent";
    const { sessionDir, published } = setup(threadId);

    publishBackgroundTaskNotificationToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      event: lateNotification({ subagent_run_id: "sub-1" }) as never
    });

    expect(published).toHaveLength(0);
    expect(await getThreadEventBus(sessionDir).read(threadId)).toEqual([]);
  });

  test("attention 与未知 status 不注入(四态外丢弃,同 projector 语义)", async () => {
    const threadId = "run-task-bus-attention";
    const { sessionDir, published } = setup(threadId);

    publishBackgroundTaskNotificationToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      event: lateNotification({ status: "attention" }) as never
    });
    publishBackgroundTaskNotificationToBus({
      sessionDir,
      threadId,
      runId: "lume-run-1",
      event: lateNotification({ status: "running" }) as never
    });

    expect(published).toHaveLength(0);
    expect(await getThreadEventBus(sessionDir).read(threadId)).toEqual([]);
  });
});
