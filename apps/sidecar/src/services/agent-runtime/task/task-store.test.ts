import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedTaskStore } from "./task-store";

const context = (threadType: "main" | "subagent" = "main") => ({
  threadId: "thread-1",
  threadType,
  actorId: "main:thread-1",
});

async function withStore<T>(fn: (store: ReturnType<typeof createFileBackedTaskStore>, sessionDir: string) => Promise<T>): Promise<T> {
  const sessionDir = await mkdtemp(join(tmpdir(), "lume-task-store-"));
  try {
    return await fn(createFileBackedTaskStore(sessionDir, { taskListId: "thread-1" }), sessionDir);
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}

describe("FileBackedTaskStore", () => {
  test("persists task items and rejects non-main access", async () => {
    await withStore(async (store, sessionDir) => {
      const created = await store.create({ subject: "Inspect runtime" }, context());
      expect(created.task).toMatchObject({ id: "1", subject: "Inspect runtime", status: "pending" });

      const restored = createFileBackedTaskStore(sessionDir, { taskListId: "thread-1" });
      await expect(restored.list({}, context("subagent"))).rejects.toThrow("Only the main agent");
      expect((await restored.get("1", context()))?.task.subject).toBe("Inspect runtime");
    });
  });

  test("enforces one active Task and claim fencing", async () => {
    await withStore(async (store) => {
      const first = await store.create({ subject: "First" }, context());
      const second = await store.create({ subject: "Second" }, context());
      const claimed = await store.update({ taskId: first.task.id, status: "in_progress", expectedRevision: first.revision }, context());
      expect(claimed.claimToken).toBeString();

      await expect(store.update({ taskId: second.task.id, status: "in_progress", expectedRevision: second.revision }, context())).rejects.toThrow("already has active Task");
      await expect(store.update({ taskId: first.task.id, status: "completed", expectedRevision: first.revision }, context())).rejects.toThrow("revision conflict");
    });
  });

  test("updates both dependency directions and rejects cycles", async () => {
    await withStore(async (store) => {
      const first = await store.create({ subject: "First" }, context());
      const second = await store.create({ subject: "Second" }, context());
      await store.update({ taskId: first.task.id, addBlocks: [second.task.id] }, context());
      expect((await store.get(second.task.id, context()))?.task.blockedBy).toEqual([first.task.id]);
      await expect(store.update({ taskId: second.task.id, addBlocks: [first.task.id] }, context())).rejects.toThrow("cycle");
    });
  });

  test("fences a stopped executor until a terminal acknowledgement", async () => {
    await withStore(async (store) => {
      const created = await store.create({ subject: "Cancelable" }, context());
      const claimed = await store.update({ taskId: created.task.id, status: "in_progress", expectedRevision: created.revision }, context());
      const bound = await store.bindExecutor({
        taskId: created.task.id,
        claimToken: claimed.claimToken!,
        expectedRevision: claimed.revision,
        executorRef: "executor-1",
      }, context());
      const stopped = await store.stop({ taskId: created.task.id, expectedRevision: bound.revision, claimToken: claimed.claimToken }, context());
      expect(stopped.task.status).toBe("pending");

      const next = await store.create({ subject: "Next" }, context());
      await expect(store.update({ taskId: next.task.id, status: "in_progress", expectedRevision: next.revision }, context())).rejects.toThrow("fenced");
      await store.acknowledgeExecutor({ taskId: created.task.id, claimToken: claimed.claimToken!, executorRef: "executor-1", terminal: true }, context());
      await expect(store.update({ taskId: next.task.id, status: "in_progress", expectedRevision: next.revision }, context())).resolves.toBeTruthy();
    });
  });

  test("does not complete a Task before its executor acknowledges termination and records the result", async () => {
    await withStore(async (store) => {
      const created = await store.create({ subject: "Executor result" }, context());
      const claimed = await store.update({ taskId: created.task.id, status: "in_progress", expectedRevision: created.revision }, context());
      const bound = await store.bindExecutor({
        taskId: created.task.id,
        claimToken: claimed.claimToken!,
        expectedRevision: claimed.revision,
        executorRef: "executor-result",
      }, context());

      await expect(store.update({
        taskId: created.task.id,
        status: "completed",
        expectedRevision: bound.revision,
        claimToken: claimed.claimToken,
      }, context())).rejects.toThrow("executor is active");

      const acknowledged = await store.acknowledgeExecutor({
        taskId: created.task.id,
        claimToken: claimed.claimToken!,
        executorRef: "executor-result",
        terminal: true,
        resultSummary: "Implemented and verified the change",
      }, context());
      expect(acknowledged.task.metadata?._lume).toMatchObject({
        lastResult: { status: "completed", summary: "Implemented and verified the change" },
      });
      await expect(store.update({
        taskId: created.task.id,
        status: "completed",
        expectedRevision: acknowledged.revision,
        claimToken: claimed.claimToken,
      }, context())).resolves.toBeTruthy();

      const abortedTask = await store.create({ subject: "Aborted executor" }, context());
      const abortedClaim = await store.update({ taskId: abortedTask.task.id, status: "in_progress", expectedRevision: abortedTask.revision }, context());
      const abortedBinding = await store.bindExecutor({
        taskId: abortedTask.task.id,
        claimToken: abortedClaim.claimToken!,
        expectedRevision: abortedClaim.revision,
        executorRef: "executor-aborted",
      }, context());
      const abortedAck = await store.acknowledgeExecutor({
        taskId: abortedTask.task.id,
        claimToken: abortedClaim.claimToken!,
        executorRef: "executor-aborted",
        terminal: true,
        resultStatus: "aborted",
      }, context());
      expect(abortedAck.task.metadata?._lume).toMatchObject({ lastResult: { status: "aborted" } });
      expect(abortedBinding.claimToken).toBe(abortedClaim.claimToken);
    });
  });

  test("does not let metadata null erase server-managed claim data", async () => {
    await withStore(async (store) => {
      const created = await store.create({ subject: "Metadata" }, context());
      const claimed = await store.update({ taskId: created.task.id, status: "in_progress", expectedRevision: created.revision }, context());
      const updated = await store.update({ taskId: created.task.id, metadata: null }, context());
      expect(updated.claimToken).toBe(claimed.claimToken);
    });
  });

  test("recovers a pending journal before reads and never reuses deleted IDs", async () => {
    await withStore(async (store, sessionDir) => {
      const created = await store.create({ subject: "Original" }, context());
      const taskPath = join(sessionDir, "tasks", "thread-1", `${created.task.id}.json`);
      const stored = JSON.parse(await readFile(taskPath, "utf8")) as Record<string, unknown>;
      stored.subject = "Recovered";
      stored.revision = created.revision + 1;
      await writeFile(
        join(sessionDir, "tasks", "thread-1", ".journal.jsonl"),
        `${JSON.stringify({
          phase: "prepare",
          transactionId: "recovery-1",
          files: [{ path: taskPath, contents: JSON.stringify(stored) }],
        })}\n`,
        "utf8",
      );

      const restored = createFileBackedTaskStore(sessionDir, { taskListId: "thread-1" });
      expect((await restored.get(created.task.id, context()))?.task.subject).toBe("Recovered");
      await restored.delete(created.task.id, context());
      const next = await restored.create({ subject: "Next" }, context());
      expect(next.task.id).toBe("2");
    });
  });
});
