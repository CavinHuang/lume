import { describe, expect, test } from "bun:test";
import type { LumeRuntimeEvent, Task } from "@lume/agent-sdk";
import { emitTaskProgress, getTaskCompletionBlocker } from "./task-tools";

function task(id: string, status: Task["status"]): Task {
  return { id, subject: `任务${id}`, status, blocks: [], blockedBy: [] };
}

function emit(tasks: Task[]): LumeRuntimeEvent {
  let captured: LumeRuntimeEvent | undefined;
  emitTaskProgress(
    {
      threadId: "thread-1",
      runId: "run-1",
      emitRuntimeEvent: (event) => {
        captured = event;
      },
    },
    {
      taskListId: "thread-1",
      sequence: 1,
      origin: "agent",
      tasks,
      task: tasks[tasks.length - 1],
      message: "Task updated: 1",
    },
  );
  expect(captured?.type).toBe("task.progress");
  return captured!;
}

describe("emitTaskProgress 状态派生", () => {
  test("有任务执行中 → in_progress，currentTaskId 指向执行中任务", () => {
    const event = emit([task("1", "completed"), task("2", "in_progress"), task("3", "pending")]);
    expect(event.status).toBe("in_progress");
    if (event.type === "task.progress") {
      expect(event.currentTaskId).toBe("2");
    }
  });

  test("全部完成 → completed，无 currentTaskId", () => {
    const event = emit([task("1", "completed"), task("2", "completed")]);
    expect(event.status).toBe("completed");
    if (event.type === "task.progress") {
      expect(event.currentTaskId).toBeUndefined();
    }
  });

  test("部分完成但无人在跑 → in_progress（不回落 pending，UI 才能看到执行中）", () => {
    const event = emit([task("1", "completed"), task("2", "pending")]);
    expect(event.status).toBe("in_progress");
  });

  test("全部 pending（尚未开始）→ pending", () => {
    const event = emit([task("1", "pending"), task("2", "pending")]);
    expect(event.status).toBe("pending");
  });

  test("空任务列表（全部删除后）→ pending，不误报 completed", () => {
    const event = emit([]);
    expect(event.status).toBe("pending");
  });

  test("事件元数据：id 含序列号、runId 缺省回落 threadId", () => {
    let captured: LumeRuntimeEvent | undefined;
    emitTaskProgress(
      {
        threadId: "thread-1",
        emitRuntimeEvent: (event) => {
          captured = event;
        },
      },
      {
        taskListId: "thread-1",
        sequence: 7,
        origin: "agent",
        tasks: [task("1", "pending")],
        task: task("1", "pending"),
      },
    );
    if (captured?.type === "task.progress") {
      expect(captured.id).toBe("task.progress:thread-1:7");
      expect(captured.runId).toBe("thread-1");
      expect(captured.sequence).toBe(7);
    } else {
      throw new Error("expected task.progress event");
    }
  });
});

describe("getTaskCompletionBlocker 完成门控", () => {
  test("只拦执行中遗留，放行合法跨回合 pending", () => {
    expect(getTaskCompletionBlocker([{ id: "1", subject: "A", status: "in_progress" }])).toContain("in_progress");
    expect(getTaskCompletionBlocker([{ id: "1", subject: "A", status: "pending" }])).toBeUndefined();
    expect(getTaskCompletionBlocker([])).toBeUndefined();
  });

  test("多条执行中遗留列出预览与计数", () => {
    const blocker = getTaskCompletionBlocker([
      { id: "1", subject: "A", status: "in_progress" },
      { id: "2", subject: "B", status: "in_progress" },
    ]);
    expect(blocker).toContain("2 个任务仍处于执行中");
    expect(blocker).toContain("A");
    expect(blocker).toContain("B");
  });
});
