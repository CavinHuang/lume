import { describe, expect, test } from "bun:test";
import { aggregateTaskProgressItems } from "./TaskProgressCard";
import type { ToolActivity } from "@/atoms";

describe("TaskProgressCard", () => {
  test("应从 TodoWrite 聚合任务列表", () => {
    const activities: ToolActivity[] = [{
      toolUseId: "todo-1",
      toolName: "TodoWrite",
      input: {
        todos: [
          { content: "拆分消息渲染", status: "completed" },
          { subject: "聚合进度卡片", status: "in_progress", activeForm: "正在聚合进度卡片" }
        ]
      },
      done: true
    }];

    expect(aggregateTaskProgressItems(activities, false)).toEqual([
      { id: "todo-0", subject: "拆分消息渲染", status: "completed", activeForm: undefined },
      { id: "todo-1", subject: "聚合进度卡片", status: "in_progress", activeForm: "正在聚合进度卡片" }
    ]);
  });

  test("应将 TaskCreate 与 TaskUpdate 聚合成最新状态", () => {
    const activities: ToolActivity[] = [
      {
        toolUseId: "create-1",
        toolName: "TaskCreate",
        input: { subject: "实现进度卡片" },
        result: "Task #7 created successfully: 实现进度卡片",
        done: true
      },
      {
        toolUseId: "update-1",
        toolName: "TaskUpdate",
        input: { taskId: "7", status: "completed" },
        done: true
      }
    ];

    expect(aggregateTaskProgressItems(activities, false)).toEqual([
      { id: "7", subject: "实现进度卡片", status: "completed", activeForm: undefined }
    ]);
  });

  test("流式结束后应将 in_progress 降级为 pending", () => {
    const activities: ToolActivity[] = [{
      toolUseId: "update-1",
      toolName: "TaskUpdate",
      input: { taskId: "7", subject: "等待下一步", status: "in_progress", activeForm: "正在等待下一步" },
      done: true
    }];

    expect(aggregateTaskProgressItems(activities, true)).toEqual([
      { id: "7", subject: "等待下一步", status: "pending", activeForm: "正在等待下一步" }
    ]);
  });

  test("应聚合子任务工具状态", () => {
    const activities: ToolActivity[] = [
      {
        toolUseId: "agent-1",
        toolName: "threads_spawn",
        input: { task: "拆分分析模块" },
        progressDescription: "正在执行拆分分析模块",
        done: false
      },
      {
        toolUseId: "agent-2",
        toolName: "subagents_send",
        input: { message: "补齐回归测试" },
        done: true
      },
      {
        toolUseId: "agent-3",
        toolName: "subagents_kill",
        input: { message: "停止异常子任务" },
        isError: true,
        done: true
      }
    ];

    expect(aggregateTaskProgressItems(activities, false)).toEqual([
      { id: "agent-1", subject: "拆分分析模块", status: "in_progress", activeForm: "正在执行拆分分析模块" },
      { id: "agent-2", subject: "补齐回归测试", status: "completed", activeForm: "补齐回归测试" },
      { id: "agent-3", subject: "停止异常子任务", status: "failed", activeForm: "停止异常子任务" }
    ]);
  });
});
