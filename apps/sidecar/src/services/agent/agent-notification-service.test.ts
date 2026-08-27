import { describe, expect, test } from "bun:test";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import {
  createAgentNotificationEmitter,
  createRunFailedRuntimeEvent,
  createUserSubmittedRuntimeEvent,
  emitRuntimeEventNotification
} from "./agent-notification-service";

describe("createAgentNotificationEmitter onError run.failed 合成闸门(T7c fix round 1)", () => {
  test("run 外失败(缺省调用):合成 runtime-error run.failed 兜底发出", () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const outerErrors: string[] = [];
    const emitter = createAgentNotificationEmitter({
      threadId: "thread-off",
      writeNotification: (method, params) => notifications.push({ method, params }),
      onError: (error) => outerErrors.push(error)
    });

    emitter.onError?.("启动缺少模型");

    const runFailed = notifications.filter((item) =>
      item.method === AGENT_IPC_CHANNELS.RUNTIME_EVENT
      && (item.params as { event?: { type?: string; runId?: string } }).event?.type === "run.failed"
    );
    expect(runFailed).toHaveLength(1);
    expect((runFailed[0]!.params as { event: { runId: string } }).event.runId).toBe("runtime-error:thread-off");
    // 外层回调不受闸门影响
    expect(outerErrors).toEqual(["启动缺少模型"]);
  });

  test("run 内失败(fromActiveRun=true):不合成 run.failed(总线 run.end{isError} 单源)", () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const outerErrors: string[] = [];
    const emitter = createAgentNotificationEmitter({
      threadId: "thread-on",
      writeNotification: (method, params) => notifications.push({ method, params }),
      onError: (error) => outerErrors.push(error)
    });

    emitter.onError?.("network failed", { fromActiveRun: true });

    expect(notifications.filter((item) =>
      item.method === AGENT_IPC_CHANNELS.RUNTIME_EVENT
      && (item.params as { event?: { type?: string } }).event?.type === "run.failed"
    )).toHaveLength(0);
    expect(outerErrors).toEqual(["network failed"]);
  });
});

// #553 第四轮补充:RUNTIME_EVENT envelope 组装收敛单一工厂——各域只声明
// 「发什么类型的事件」,envelope({threadId,event}) 与 id/runId 字段口径单点保证
describe("RUNTIME_EVENT 单一工厂(#553)", () => {
  test("emitRuntimeEventNotification 以 {threadId,event} 包络发到 RUNTIME_EVENT 通道,支持 DI writer", () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const event = {
      id: "run-1:run.started",
      type: "run.started",
      runId: "run-1",
      threadId: "thread-1",
      createdAt: "2026-08-27T00:00:00.000Z"
    } as never;

    emitRuntimeEventNotification("thread-1", event, (method, params) => notifications.push({ method, params }));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      method: AGENT_IPC_CHANNELS.RUNTIME_EVENT,
      params: { threadId: "thread-1", event }
    });
  });

  test("createUserSubmittedRuntimeEvent id/runId 口径与桌面路径一致,含 parts/capabilities 透传", () => {
    const event = createUserSubmittedRuntimeEvent("thread-1", {
      id: "message-1",
      role: "user",
      content: "&整理供应商页面",
      createdAt: 1_785_635_761_455,
      versionGroupId: "vg-1",
      versionIndex: 2,
      versionCount: 3,
      metadata: {
        messageParts: [{ type: "planning_todo_ref", todoId: "todo-1" }],
        capabilityReferenceViews: [{ kind: "skill", id: "s-1" }]
      }
    } as never);

    expect(event).toMatchObject({
      id: "thread-1:message-1:message.user.submitted",
      type: "message.user.submitted",
      runId: "message:message-1",
      threadId: "thread-1",
      text: "&整理供应商页面",
      messageId: "message-1",
      versionGroupId: "vg-1",
      versionIndex: 2,
      versionCount: 3,
      messageParts: [{ type: "planning_todo_ref", todoId: "todo-1" }],
      capabilityReferences: [{ kind: "skill", id: "s-1" }]
    });
  });

  test("createUserSubmittedRuntimeEvent 消息缺 id 时 runId/id 回退 createdAt(ISO 化)", () => {
    const event = createUserSubmittedRuntimeEvent("thread-1", {
      role: "user",
      content: "hi",
      createdAt: 1_785_635_761_455
    } as never);

    expect(event.id).toBe("thread-1:2026-08-02T01:56:01.455Z:message.user.submitted");
    expect(event.runId).toBe("message:2026-08-02T01:56:01.455Z");
  });

  test("createRunFailedRuntimeEvent id/runId/error 口径与 onError 兜底路径一致", () => {
    const event = createRunFailedRuntimeEvent("thread-1", "启动缺少模型");

    expect(event.type).toBe("run.failed");
    expect(event.threadId).toBe("thread-1");
    expect(event.runId).toBe("runtime-error:thread-1");
    expect(event.error).toEqual({ code: "runtime_error", message: "启动缺少模型" });
    expect(event.id).toMatch(/^thread-1:\d+:run\.failed$/);
    expect(typeof Date.parse(event.createdAt)).toBe("number");
  });
});

describe("createAgentNotificationEmitter", () => {
  test("forwards an internally started turn through the normal Agent notification channels", () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const emitter = createAgentNotificationEmitter({
      threadId: "thread-1",
      writeNotification: (method, params) => notifications.push({ method, params })
    });

    emitter.onMessageAppended?.({
      threadId: "thread-1",
      message: {
        id: "message-1",
        role: "user",
        content: "&整理供应商页面",
        createdAt: 1_785_635_761_455,
        metadata: {
          messageParts: [{ type: "planning_todo_ref", todoId: "todo-1" }]
        }
      }
    } as never);
    emitter.onRuntimeEvent?.({
      id: "run-1:run.started",
      type: "run.started",
      runId: "run-1",
      threadId: "thread-1",
      createdAt: "2026-08-02T01:56:01.455Z"
    } as never);

    expect(notifications.map((item) => item.method)).toEqual([
      AGENT_IPC_CHANNELS.MESSAGE_APPENDED,
      AGENT_IPC_CHANNELS.RUNTIME_EVENT,
      AGENT_IPC_CHANNELS.RUNTIME_EVENT
    ]);
    expect(notifications[1]?.params).toMatchObject({
      threadId: "thread-1",
      event: {
        type: "message.user.submitted",
        text: "&整理供应商页面",
        messageParts: [{ type: "planning_todo_ref", todoId: "todo-1" }]
      }
    });
    expect(notifications[2]?.params).toMatchObject({
      threadId: "thread-1",
      event: { type: "run.started", runId: "run-1" }
    });
  });
});
