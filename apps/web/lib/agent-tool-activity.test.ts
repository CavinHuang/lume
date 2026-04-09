import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@lume/shared";
import type { ToolActivity } from "./agent-streaming";
import {
  extractToolActivitiesFromMessages,
  getToolActivityStatus,
  mergeToolActivities
} from "./agent-tool-activity";

describe("agent-tool-activity", () => {
  test("extractToolActivitiesFromMessages 应从 assistant sdkMessages 重建 tool activity", () => {
    const messages: AgentMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "",
        createdAt: 1,
        sdkMessages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { path: "README.md" }
              }]
            }
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "ok"
              }]
            }
          }
        ] as AgentMessage["sdkMessages"]
      }
    ];

    expect(extractToolActivitiesFromMessages(messages)).toEqual([
      {
        toolUseId: "tool-1",
        toolName: "Read",
        input: { path: "README.md" },
        intent: undefined,
        displayName: undefined,
        parentToolUseId: undefined,
        result: "ok",
        isError: false,
        done: true
      }
    ]);
  });

  test("extractToolActivitiesFromMessages 应识别独立 tool_result sdk 消息", () => {
    const messages: AgentMessage[] = [
      {
        id: "m-tool-result",
        role: "assistant",
        content: "",
        createdAt: 1,
        sdkMessages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{
                type: "tool_use",
                id: "tool-openai-1",
                name: "Read",
                input: { path: "README.md" }
              }]
            }
          },
          {
            type: "tool_result",
            result: {
              tool_use_id: "tool-openai-1",
              tool_name: "Read",
              output: "file content"
            }
          }
        ] as AgentMessage["sdkMessages"]
      }
    ];

    expect(extractToolActivitiesFromMessages(messages)).toEqual([
      {
        toolUseId: "tool-openai-1",
        toolName: "Read",
        input: { path: "README.md" },
        intent: undefined,
        displayName: undefined,
        parentToolUseId: undefined,
        result: "file content",
        isError: false,
        done: true
      }
    ]);
  });

  test("mergeToolActivities 应用 streaming 状态覆盖 history 同 toolUseId 条目", () => {
    const history: ToolActivity[] = [
      {
        toolUseId: "tool-1",
        toolName: "Read",
        input: {},
        done: true,
        result: "old"
      }
    ];
    const streaming: ToolActivity[] = [
      {
        toolUseId: "tool-1",
        toolName: "Read",
        input: { path: "new" },
        done: false
      }
    ];

    expect(mergeToolActivities(history, streaming)).toEqual([
      {
        toolUseId: "tool-1",
        toolName: "Read",
        input: { path: "new" },
        intent: undefined,
        displayName: undefined,
        parentToolUseId: undefined,
        result: "old",
        isError: undefined,
        startedAt: undefined,
        elapsedSeconds: undefined,
        elapsedMs: undefined,
        taskId: undefined,
        shellId: undefined,
        isBackground: undefined,
        done: false
      }
    ]);
  });

  test("extractToolActivitiesFromMessages 应恢复 task_progress 上报的毫秒时长", () => {
    const messages: AgentMessage[] = [
      {
        id: "m2",
        role: "assistant",
        content: "",
        createdAt: 1,
        sdkMessages: [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{
                type: "tool_use",
                id: "tool-2",
                name: "Bash",
                input: { command: "ls -la" }
              }]
            }
          },
          {
            type: "system",
            subtype: "task_started",
            task_id: "task-2",
            tool_use_id: "tool-2",
            description: "执行 Bash"
          },
          {
            type: "system",
            subtype: "task_progress",
            task_id: "task-2",
            tool_use_id: "tool-2",
            description: "执行中",
            usage: { total_tokens: 0, tool_uses: 1, duration_ms: 975 }
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [{
                type: "tool_result",
                tool_use_id: "tool-2",
                content: "ok"
              }]
            }
          }
        ] as AgentMessage["sdkMessages"]
      }
    ];

    expect(extractToolActivitiesFromMessages(messages)).toEqual([{
      toolUseId: "tool-2",
      toolName: "Bash",
      input: { command: "ls -la" },
      intent: "执行 Bash",
      displayName: undefined,
      parentToolUseId: undefined,
      taskId: "task-2",
      startedAt: expect.any(Number),
      elapsedSeconds: 0,
      elapsedMs: 975,
      progressDescription: "执行中",
      result: "ok",
      isError: false,
      done: true
    }]);
  });

  test("getToolActivityStatus 应区分 background/running/error/completed", () => {
    expect(getToolActivityStatus({ toolUseId: "a", toolName: "A", input: {}, done: false, isBackground: true })).toBe("backgrounded");
    expect(getToolActivityStatus({ toolUseId: "b", toolName: "B", input: {}, done: false })).toBe("running");
    expect(getToolActivityStatus({ toolUseId: "c", toolName: "C", input: {}, done: true, isError: true })).toBe("error");
    expect(getToolActivityStatus({ toolUseId: "d", toolName: "D", input: {}, done: true })).toBe("completed");
  });
});
