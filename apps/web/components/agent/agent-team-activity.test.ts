import { describe, expect, test } from "bun:test";
import type { AgentMessage, SDKMessage } from "@lume/shared";
import { findLatestTodoItems, parseTodoItemsFromInput, resolveTodoPanelExpanded } from "./agent-team-activity";

describe("agent-team-activity", () => {
  test("应优先从完整 sdk transcript 中提取最新 TodoWrite", () => {
    const sdkMessages: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "收敛 transcript 渲染", status: "completed" },
                { content: "清理 fallback 路径", status: "in_progress", activeForm: "正在清理 fallback 路径" }
              ]
            }
          }]
        }
      }
    ];

    const todos = findLatestTodoItems([], sdkMessages, []);

    expect(todos).toEqual([
      { content: "收敛 transcript 渲染", status: "completed", activeForm: undefined },
      { content: "清理 fallback 路径", status: "in_progress", activeForm: "正在清理 fallback 路径" }
    ]);
  });

  test("sdk transcript 不可用时应回退到旧 assistant message sdkMessages", () => {
    const messages: AgentMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        createdAt: 1,
        sdkMessages: [{
          type: "assistant",
          message: {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "todo-legacy",
              name: "TaskCreate",
              input: {
                todos: [
                  { subject: "兼容旧路径", status: "pending" }
                ]
              }
            }]
          }
        }]
      }
    ];

    const todos = findLatestTodoItems([], [], messages);

    expect(todos).toEqual([
      { content: "兼容旧路径", status: "pending", activeForm: undefined }
    ]);
  });

  test("parseTodoItemsFromInput 应忽略空内容条目", () => {
    expect(parseTodoItemsFromInput({
      todos: [
        { content: "" },
        { subject: "保留项", status: "completed" }
      ]
    })).toEqual([
      { content: "保留项", status: "completed", activeForm: undefined }
    ]);
  });

  test("resolveTodoPanelExpanded 应在全部完成时自动折叠", () => {
    const previous = [{ content: "A", status: "in_progress" as const }];
    const next = [{ content: "A", status: "completed" as const }];
    expect(resolveTodoPanelExpanded(previous, next)).toBe(false);
  });
});
