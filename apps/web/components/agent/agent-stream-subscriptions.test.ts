import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@lume/shared";
import { shouldAutoOpenTeamPanel } from "./agent-stream-subscriptions";

describe("agent-stream-subscriptions", () => {
  test("task_started 事件应自动打开 team panel", () => {
    const event: AgentEvent = {
      type: "task_started",
      taskId: "task-1",
      description: "run child task"
    };

    expect(shouldAutoOpenTeamPanel(event)).toBe(true);
  });

  test("Agent/Task/sessions_spawn 工具启动应自动打开 team panel", () => {
    const agentToolStart: AgentEvent = {
      type: "tool_start",
      toolName: "Agent",
      toolUseId: "tool-1",
      input: {}
    };
    const taskToolStart: AgentEvent = {
      type: "tool_start",
      toolName: "Task",
      toolUseId: "tool-2",
      input: {}
    };
    const spawnToolStart: AgentEvent = {
      type: "tool_start",
      toolName: "sessions_spawn",
      toolUseId: "tool-3",
      input: {}
    };

    expect(shouldAutoOpenTeamPanel(agentToolStart)).toBe(true);
    expect(shouldAutoOpenTeamPanel(taskToolStart)).toBe(true);
    expect(shouldAutoOpenTeamPanel(spawnToolStart)).toBe(true);
  });

  test("普通文本和其他工具事件不应自动打开 team panel", () => {
    const textEvent: AgentEvent = {
      type: "text_delta",
      text: "hello"
    };
    const otherToolEvent: AgentEvent = {
      type: "tool_start",
      toolName: "Read",
      toolUseId: "tool-4",
      input: {}
    };

    expect(shouldAutoOpenTeamPanel(textEvent)).toBe(false);
    expect(shouldAutoOpenTeamPanel(otherToolEvent)).toBe(false);
  });
});
