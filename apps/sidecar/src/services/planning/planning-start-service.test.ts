import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createAgentThreadWithModelRef,
  getAgentThreadMeta
} from "../agent/agent-thread-manager";
import { writeAgentMessageVersionStore } from "../agent/agent-message-version-store";
import { resetAgentSubmissionStoreForTests } from "../agent/agent-submission-store";
import { getPlanningTodoStore, resetPlanningTodoStoreForTests } from "./planning-todo-store";
import { reconcilePlanningStartOperations } from "./planning-start-service";

describe("planning start 管线崩溃窗口 reconcile(#647 P1-6)", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-planning-reconcile-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    resetAgentSubmissionStoreForTests();
    resetPlanningTodoStoreForTests();
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("thread_created 相位且无任何回执时，reconcile 补偿删除空线程并落 compensated", () => {
    const store = getPlanningTodoStore();
    const todo = store.create({ title: "孤儿启动" }).todo!;
    const operation = store.reserveOperation({
      operationId: "op-orphan-reconcile",
      kind: "start",
      todoId: todo.id,
      clientSubmissionId: "sub-orphan-reconcile"
    });
    const thread = createAgentThreadWithModelRef(
      `处理：${todo.title}`,
      undefined,
      undefined,
      todo.workspaceId,
      undefined,
      undefined,
      { planningOperationId: operation.operationId, planningTodoId: todo.id }
    );
    store.advanceOperation(operation.operationId, {
      phase: "thread_created",
      status: "running",
      threadId: thread.id
    });

    reconcilePlanningStartOperations();

    expect(getAgentThreadMeta(thread.id)).toBeUndefined();
    const envelope = store.getOperation(operation.operationId);
    expect(envelope?.status).toBe("compensated");
    expect(envelope?.phase).toBe("reconciled");
  });

  test("reserved 相位（尚无 threadId）的操作不被 reconcile 触碰", () => {
    const store = getPlanningTodoStore();
    const todo = store.create({ title: "reserved 占位" }).todo!;
    const operation = store.reserveOperation({
      operationId: "op-reserved-guard",
      kind: "start",
      todoId: todo.id,
      clientSubmissionId: "sub-reserved-guard"
    });
    expect(operation.phase).toBe("reserved");

    reconcilePlanningStartOperations();

    const envelope = store.getOperation(operation.operationId);
    expect(envelope?.phase).toBe("reserved");
    expect(envelope?.status).toBe(operation.status);
  });

  test("thread_created 但线程已有消息时，reconcile 不动（护栏负向）", () => {
    const store = getPlanningTodoStore();
    const todo = store.create({ title: "有消息残留" }).todo!;
    const operation = store.reserveOperation({
      operationId: "op-messages-guard",
      kind: "start",
      todoId: todo.id,
      clientSubmissionId: "sub-messages-guard"
    });
    const thread = createAgentThreadWithModelRef(
      `处理：${todo.title}`,
      undefined,
      undefined,
      todo.workspaceId,
      undefined,
      undefined,
      { planningOperationId: operation.operationId, planningTodoId: todo.id }
    );
    store.advanceOperation(operation.operationId, {
      phase: "thread_created",
      status: "running",
      threadId: thread.id
    });
    // 播种一条可见消息：模糊态（可能含未持久化回执的内容）必须保持原样不冒险
    writeAgentMessageVersionStore(thread.id, {
      version: 1,
      sessionId: thread.id,
      groups: [{
        groupId: "g1",
        turnId: "t1",
        role: "user",
        latestMessageId: "m1",
        messageIds: ["m1"],
        createdAt: 0,
        updatedAt: 0
      }],
      messages: [{
        messageId: "m1",
        groupId: "g1",
        role: "user",
        versionIndex: 1,
        isLatestVersion: true,
        createdAt: 0,
        content: "崩溃前已落盘的消息"
      }],
      visibleGroupIds: ["g1"],
      updatedAt: 0
    });

    reconcilePlanningStartOperations();

    expect(getAgentThreadMeta(thread.id)).toBeDefined();
    const envelope = store.getOperation(operation.operationId);
    expect(envelope?.phase).toBe("thread_created");
    expect(envelope?.status).toBe("running");
  });

  test("compensated 终态对同 key 重试如实返回，不复活幽灵 threadId", () => {
    const store = getPlanningTodoStore();
    const todo = store.create({ title: "补偿后重试" }).todo!;
    const operation = store.reserveOperation({
      operationId: "op-compensated-retry",
      kind: "start",
      todoId: todo.id,
      clientSubmissionId: "sub-compensated-retry"
    });
    const thread = createAgentThreadWithModelRef(
      `处理：${todo.title}`,
      undefined,
      undefined,
      todo.workspaceId,
      undefined,
      undefined,
      { planningOperationId: operation.operationId, planningTodoId: todo.id }
    );
    store.advanceOperation(operation.operationId, {
      phase: "thread_created",
      status: "running",
      threadId: thread.id
    });
    reconcilePlanningStartOperations();
    expect(getAgentThreadMeta(thread.id)).toBeUndefined();

    // 模拟同 idempotencyKey 的客户端重试路径：reserveOperation 幂等返回旧 envelope
    const retried = store.reserveOperation({
      operationId: "op-compensated-retry",
      kind: "start",
      todoId: todo.id,
      clientSubmissionId: "sub-compensated-retry"
    });
    expect(retried.status).toBe("compensated");
  });
});
