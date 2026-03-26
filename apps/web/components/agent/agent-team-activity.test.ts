import { describe, expect, test } from "bun:test";
import { resolveTodoPanelExpanded, type TodoItem } from "./agent-team-activity";

describe("agent-team-activity", () => {
  test("首次加载未全部完成的 todo 时应展开面板", () => {
    const nextTodos: TodoItem[] = [
      { content: "task a", status: "pending" }
    ];

    expect(resolveTodoPanelExpanded(null, nextTodos)).toBe(true);
  });

  test("首次加载全部完成的 todo 时应收起面板", () => {
    const nextTodos: TodoItem[] = [
      { content: "task a", status: "completed" }
    ];

    expect(resolveTodoPanelExpanded(null, nextTodos)).toBe(false);
  });

  test("写入新的未完成 todo 时应展开面板", () => {
    const prevTodos: TodoItem[] = [
      { content: "task a", status: "completed" }
    ];
    const nextTodos: TodoItem[] = [
      { content: "task a", status: "completed" },
      { content: "task b", status: "pending" }
    ];

    expect(resolveTodoPanelExpanded(prevTodos, nextTodos)).toBe(true);
  });

  test("从未完成变为全部完成时应收起面板", () => {
    const prevTodos: TodoItem[] = [
      { content: "task a", status: "in_progress" }
    ];
    const nextTodos: TodoItem[] = [
      { content: "task a", status: "completed" }
    ];

    expect(resolveTodoPanelExpanded(prevTodos, nextTodos)).toBe(false);
  });

  test("无变化时不应强制改写面板状态", () => {
    const prevTodos: TodoItem[] = [
      { content: "task a", status: "pending" }
    ];
    const nextTodos: TodoItem[] = [
      { content: "task a", status: "pending" }
    ];

    expect(resolveTodoPanelExpanded(prevTodos, nextTodos)).toBe(null);
  });
});
