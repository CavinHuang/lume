import { describe, expect, test } from "bun:test";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { createAgentNotificationEmitter } from "./agent-notification-service";

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
