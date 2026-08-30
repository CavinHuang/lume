import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { utimesSync } from "node:fs";
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

  test("上一 run 遗留的僵尸 in_progress 在新 run 认领时自动释放", async () => {
    await withStore(async (store) => {
      const run1 = { ...context(), runId: "parent-run-1" };
      const run2 = { ...context(), runId: "parent-run-2" };
      const interrupted = await store.create({ subject: "Interrupted" }, run1);
      await store.update({ taskId: interrupted.task.id, status: "in_progress", expectedRevision: interrupted.revision }, run1);

      const next = await store.create({ subject: "Next" }, run2);
      const claimed = await store.update({ taskId: next.task.id, status: "in_progress", expectedRevision: next.revision }, run2);
      expect(claimed.claimToken).toBeString();

      const healed = await store.get(interrupted.task.id, run2);
      expect(healed?.task.status).toBe("pending");
      // create(1) → claim(2) → 僵尸释放(3)
      expect(healed?.revision).toBe(3);
    });
  });

  test("同一 run 的活跃认领不被自愈逻辑误释放", async () => {
    await withStore(async (store) => {
      const run1 = { ...context(), runId: "parent-run-1" };
      const first = await store.create({ subject: "First" }, run1);
      const second = await store.create({ subject: "Second" }, run1);
      await store.update({ taskId: first.task.id, status: "in_progress", expectedRevision: first.revision }, run1);
      await expect(store.update({ taskId: second.task.id, status: "in_progress", expectedRevision: second.revision }, run1)).rejects.toThrow("already has active Task");
    });
  });

  test("同任务僵尸：新 run 直接续做时自动释放旧认领", async () => {
    await withStore(async (store) => {
      const run1 = { ...context(), runId: "parent-run-1" };
      const run2 = { ...context(), runId: "parent-run-2" };
      const created = await store.create({ subject: "Resume" }, run1);
      await store.update({ taskId: created.task.id, status: "in_progress", expectedRevision: created.revision }, run1);

      // 新 run 不带 revision/claimToken 直接续做 → 旧认领自动释放并重新认领
      const reclaimed = await store.update({ taskId: created.task.id, status: "in_progress" }, run2);
      expect(reclaimed.claimToken).toBeString();
    });
  });

  test("宽容 fence：缺省 revision/claimToken 走通认领-完成闭环", async () => {
    await withStore(async (store) => {
      const created = await store.create({ subject: "Lenient" }, context());
      const claimed = await store.update({ taskId: created.task.id, status: "in_progress" }, context());
      expect(claimed.claimToken).toBeString();
      const completed = await store.update({ taskId: created.task.id, status: "completed" }, context());
      expect(completed.task.status).toBe("completed");
    });
  });

  test("宽容 fence：跨 actor 缺省 claimToken 被拒，显式错 token 仍被拒", async () => {
    await withStore(async (store) => {
      const created = await store.create({ subject: "Cross" }, context());
      await store.update({ taskId: created.task.id, status: "in_progress" }, context());
      const otherActor = { ...context(), actorId: "main:other" };
      await expect(store.update({ taskId: created.task.id, status: "completed" }, otherActor)).rejects.toThrow("claim token");
      await expect(store.update({ taskId: created.task.id, status: "completed", claimToken: "bogus" }, context())).rejects.toThrow("claim token");
    });
  });

  test("同一父 Run 最多认领同一 Task 三次，新 Run 可重新尝试", async () => {
    await withStore(async (store) => {
      const runContext = { ...context(), runId: "parent-run-1" };
      let current = await store.create({ subject: "Retry bounded" }, runContext);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const claimed = await store.update({
          taskId: current.task.id,
          status: "in_progress",
          expectedRevision: current.revision,
        }, runContext);
        current = await store.update({
          taskId: current.task.id,
          status: "pending",
          expectedRevision: claimed.revision,
          claimToken: claimed.claimToken,
        }, runContext);
      }

      await expect(store.update({
        taskId: current.task.id,
        status: "in_progress",
        expectedRevision: current.revision,
      }, runContext)).rejects.toThrow("最多认领同一 Task 3 次");

      await expect(store.update({
        taskId: current.task.id,
        status: "in_progress",
        expectedRevision: current.revision,
      }, { ...context(), runId: "parent-run-2" })).resolves.toBeTruthy();
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

  test("truncates oversized executor error before persisting lastError", async () => {
    await withStore(async (store) => {
      const created = await store.create({ subject: "Errored executor" }, context());
      const claimed = await store.update({ taskId: created.task.id, status: "in_progress", expectedRevision: created.revision }, context());
      await store.bindExecutor({
        taskId: created.task.id,
        claimToken: claimed.claimToken!,
        expectedRevision: claimed.revision,
        executorRef: "executor-error",
      }, context());
      const acknowledged = await store.acknowledgeExecutor({
        taskId: created.task.id,
        claimToken: claimed.claimToken!,
        executorRef: "executor-error",
        terminal: true,
        error: "x".repeat(50_000),
      }, context());
      const lume = acknowledged.task.metadata?._lume as { lastError?: { message?: string } };
      expect(lume.lastError?.message).toHaveLength(4_000);
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

  test("journal 只记 events 截断点，恢复按截断点回滚(#647 P1-7)", async () => {
    await withStore(async (store, sessionDir) => {
      const listDir = join(sessionDir, "tasks", "thread-1");
      const journalPath = join(listDir, ".journal.jsonl");
      const eventsPath = join(listDir, ".events.jsonl");

      await store.create({ subject: "A" }, context());
      const journal = await readFile(journalPath, "utf8");
      // prepare 行不得嵌入 events 全史（O(n²) 膨胀根因）
      expect(journal).not.toContain('"task.mutated"');
      // 结构断言：events 条目为 contents:null + 数值型 truncateTo（生产写入值受校验）
      const prepareLine = journal.split(/\r?\n/).find((line) => line.includes('"prepare"'));
      const eventsEntry = (JSON.parse(prepareLine!) as {
        files: Array<{ path: string; contents: string | null; truncateTo?: number }>;
      }).files.find((file) => file.path === eventsPath);
      expect(eventsEntry).toMatchObject({ contents: null });
      expect(typeof eventsEntry!.truncateTo).toBe("number");

      // 模拟崩溃：一笔未 commit 的 prepare + 事务后追加的两条伪事件
      const eventsSizeBefore = (await stat(eventsPath)).size;
      await appendFile(journalPath, `${JSON.stringify({
        phase: "prepare",
        transactionId: "txn-crash",
        files: [{ path: eventsPath, contents: null, truncateTo: eventsSizeBefore }],
      })}\n`);
      await appendFile(eventsPath, `${JSON.stringify({ type: "task.mutated", fake: 1 })}\n`);
      await appendFile(eventsPath, `${JSON.stringify({ type: "task.mutated", fake: 2 })}\n`);

      // 下一次 mutation 先走 recoverJournal：伪事件应被截断回滚，
      // 且合法事件（create A 的 sequence 1）必须完好——防过度回滚/清空
      await store.create({ subject: "B" }, context());
      const events = await readFile(eventsPath, "utf8");
      expect(events).toContain("\"sequence\":1");
      expect(events).not.toContain("\"fake\":1");
      expect(events).not.toContain("\"fake\":2");
    });
  });

  test("旧格式全量快照行（无 truncateTo）恢复语义不变(#647 P1-7 兼容)", async () => {
    await withStore(async (store, sessionDir) => {
      const listDir = join(sessionDir, "tasks", "thread-1");
      const journalPath = join(listDir, ".journal.jsonl");
      const eventsPath = join(listDir, ".events.jsonl");

      await store.create({ subject: "Legacy" }, context());
      const snapshot = await readFile(eventsPath, "utf8");
      // 手植旧格式 pending prepare：contents 记录事件全史快照，随后追加垃圾尾
      await appendFile(journalPath, `${JSON.stringify({
        phase: "prepare",
        transactionId: "txn-legacy",
        files: [{ path: eventsPath, contents: snapshot }],
      })}\n`);
      await appendFile(eventsPath, "garbage-tail\n");

      await store.create({ subject: "After legacy recovery" }, context());
      const after = await readFile(eventsPath, "utf8");
      expect(after.startsWith(snapshot)).toBe(true);
      expect(after).not.toContain("garbage-tail");
    });
  });

  test("journal 超阈值后在下一轮 recovery 压实(#647 P1-7)", async () => {
    await withStore(async (store, sessionDir) => {
      const journalPath = join(sessionDir, "tasks", "thread-1", ".journal.jsonl");
      await mkdir(join(sessionDir, "tasks", "thread-1"), { recursive: true });
      // 256KB+ 已解决（commit 配对）的历史行
      const filler = JSON.stringify({ phase: "commit", transactionId: `t-${Date.now()}-pad`, pad: "x".repeat(128) });
      const lines = Array.from({ length: 2200 }, (_, i) => JSON.stringify({ phase: "commit", transactionId: `pad-${i}`, blob: "y".repeat(128) }));
      await writeFile(journalPath, [...lines, filler].join("\n") + "\n");
      expect((await stat(journalPath)).size).toBeGreaterThan(256 * 1024);

      const created = await store.create({ subject: "Compact trigger" }, context());

      const sizeAfter = (await stat(journalPath)).size;
      expect(sizeAfter).toBeLessThan(4 * 1024);
      // 压实后 store 功能不受影响
      expect((await store.get(created.task.id, context()))?.task.subject).toBe("Compact trigger");
    });
  });

  test("持有进程存活但心跳废弃超时的锁被强制接管(#647 P1-8)", async () => {
    await withStore(async (store, sessionDir) => {
      const lockPath = join(sessionDir, "tasks", "thread-1", ".lock");
      await mkdir(join(sessionDir, "tasks", "thread-1"), { recursive: true });
      // pid 是当前存活进程：旧规则（进程死+心跳超时双条件）永不判陈旧 → 全表写操作 5s 超时
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "ghost", heartbeatAt: Date.now() - 400_000 }));

      const created = await store.create({ subject: "After ghost lock" }, context());
      expect(created.task.subject).toBe("After ghost lock");
    });
  });

  test("半截/损坏锁文件在 mtime 老化后被自愈(#647 P1-8)", async () => {
    await withStore(async (store, sessionDir) => {
      const lockPath = join(sessionDir, "tasks", "thread-1", ".lock");
      await mkdir(join(sessionDir, "tasks", "thread-1"), { recursive: true });
      await writeFile(lockPath, "{corrupt-half-written");
      const backdated = new Date(Date.now() - 60_000);
      utimesSync(lockPath, backdated, backdated);

      const created = await store.create({ subject: "After corrupt lock" }, context());
      expect(created.task.subject).toBe("After corrupt lock");
    });
  });

  test("新鲜锁不被误偷（安全半边）", async () => {
    await withStore(async (store, sessionDir) => {
      const lockPath = join(sessionDir, "tasks", "thread-1", ".lock");
      await mkdir(join(sessionDir, "tasks", "thread-1"), { recursive: true });
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "live-holder", heartbeatAt: Date.now() }));

      // 心跳新鲜且进程存活：必须保持互斥，等满 acquisition 超时
      await expect(store.create({ subject: "Should not steal" }, context())).rejects.toThrow("Task lock timeout");
    });
  }, 15_000);

  test("被未完成依赖阻塞的 Task 不得直通 completed(#647 P2-1)", async () => {
    await withStore(async (store) => {
      const blocker = await store.create({ subject: "Blocker" }, context());
      const blocked = await store.create({ subject: "Blocked" }, context());
      await store.update({ taskId: blocker.task.id, addBlocks: [blocked.task.id] }, context());
      const blockedNow = (await store.get(blocked.task.id, context()))!;

      await expect(
        store.update({ taskId: blocked.task.id, status: "completed", expectedRevision: blockedNow.revision }, context()),
      ).rejects.toThrow("blocked by unfinished dependencies");

      const blockerNow = (await store.get(blocker.task.id, context()))!;
      await store.update({ taskId: blocker.task.id, status: "completed", expectedRevision: blockerNow.revision }, context());
      const current = await store.get(blocked.task.id, context());
      await expect(
        store.update({ taskId: blocked.task.id, status: "completed", expectedRevision: current!.revision }, context()),
      ).resolves.toBeTruthy();
    });
  });

  test("同一次 update 内认领门控按变更后依赖判定(#647 P2-4)", async () => {
    await withStore(async (store) => {
      const target = await store.create({ subject: "Target" }, context());
      const other = await store.create({ subject: "Other" }, context());

      // 旧顺序（先 claim 后加阻塞）会产出“进行中却被阻塞”的矛盾态；现在必须被拦
      await expect(
        store.update({
          taskId: target.task.id,
          status: "in_progress",
          addBlockedBy: [other.task.id],
          expectedRevision: target.revision,
        }, context()),
      ).rejects.toThrow("blocked by unfinished dependencies");
      // 事务整体未生效：状态与依赖都保持原样
      const after = await store.get(target.task.id, context());
      expect(after?.task.status).toBe("pending");
      expect(after?.task.blockedBy).toEqual([]);
    });
  });

  test("移除阻塞后同调用即可认领（P2-4 正向路径）", async () => {
    await withStore(async (store) => {
      const blocker = await store.create({ subject: "Blocker" }, context());
      const target = await store.create({ subject: "Target" }, context());
      await store.update({ taskId: blocker.task.id, addBlocks: [target.task.id] }, context());

      // 同一次调用解除阻塞并认领：门控按变更后的依赖判定，应放行
      const blockerNow = (await store.get(blocker.task.id, context()))!;
      await store.update({ taskId: blocker.task.id, status: "completed", expectedRevision: blockerNow.revision }, context());
      const targetNow = (await store.get(target.task.id, context()))!;
      const claimed = await store.update({
        taskId: target.task.id,
        status: "in_progress",
        removeBlockedBy: [blocker.task.id],
        expectedRevision: targetNow.revision,
      }, context());
      expect(claimed.task.status).toBe("in_progress");
      expect(claimed.claimToken).toBeString();
    });
  });

  test("类型不符的字段更新显式报错而非静默忽略(#647 P2-3)", async () => {
    await withStore(async (store) => {
      const created = await store.create({ subject: "Typed" }, context());
      await expect(
        store.update({ taskId: created.task.id, subject: 123 as unknown as string, expectedRevision: created.revision }, context()),
      ).rejects.toThrow("subject must be a string");
      await expect(
        store.update({ taskId: created.task.id, description: { bad: true } as unknown as string, expectedRevision: created.revision }, context()),
      ).rejects.toThrow("description must be a string");
    });
  });

  test("completed 唯一出口是 reopen 到 pending，其余覆写仍被拒(#647 P2-6)", async () => {
    await withStore(async (store) => {
      const created = await store.create({ subject: "Reopenable" }, context());
      const completed = await store.update({ taskId: created.task.id, status: "completed", expectedRevision: created.revision }, context());
      expect(completed.task.status).toBe("completed");

      await expect(
        store.update({ taskId: created.task.id, status: "in_progress", expectedRevision: completed.revision }, context()),
      ).rejects.toThrow("Completed Tasks cannot be overwritten");

      const reopened = await store.update({ taskId: created.task.id, status: "pending", expectedRevision: completed.revision }, context());
      expect(reopened.task.status).toBe("pending");
      expect(reopened.task.owner).toBeUndefined();

      const reclaimed = await store.update({ taskId: created.task.id, status: "in_progress", expectedRevision: reopened.revision }, context());
      expect(reclaimed.claimToken).toBeString();
    });
  });

  test("claim metadata 不再携带零消费方的 lease 字段(#647 P2-5)", async () => {
    await withStore(async (store, sessionDir) => {
      const created = await store.create({ subject: "Leaseless" }, context());
      await store.update({ taskId: created.task.id, status: "in_progress", expectedRevision: created.revision }, context());
      const raw = JSON.parse(await readFile(join(sessionDir, "tasks", "thread-1", `${created.task.id}.json`), "utf8")) as {
        metadata: { _lume: { claim?: Record<string, unknown> } };
      };
      expect(raw.metadata._lume.claim?.token).toBeString();
      expect(raw.metadata._lume.claim?.lease).toBeUndefined();
    });
  });
});
