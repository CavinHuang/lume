import { describe, expect, test } from "bun:test";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { createAgentNotificationEmitter } from "./agent-notification-service";

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
