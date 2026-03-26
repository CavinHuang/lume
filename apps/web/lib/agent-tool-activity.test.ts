import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@lume/shared";
import type { ToolActivity } from "./agent-streaming";
import {
  extractToolActivitiesFromMessages,
  getToolActivityStatus,
  mergeToolActivities
} from "./agent-tool-activity";

describe("agent-tool-activity", () => {
  test("extractToolActivitiesFromMessages 应从 assistant events 重建 tool activity", () => {
    const messages: AgentMessage[] = [
      {
        id: "m1",
        role: "assistant",
        content: "",
        createdAt: 1,
        events: [
          {
            type: "tool_start",
            toolUseId: "tool-1",
            toolName: "Read",
            input: { path: "README.md" }
          },
          {
            type: "tool_result",
            toolUseId: "tool-1",
            toolName: "Read",
            result: "ok",
            isError: false
          }
        ]
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
        elapsedSeconds: undefined,
        taskId: undefined,
        shellId: undefined,
        isBackground: undefined,
        done: false
      }
    ]);
  });

  test("getToolActivityStatus 应区分 background/running/error/completed", () => {
    expect(getToolActivityStatus({ toolUseId: "a", toolName: "A", input: {}, done: false, isBackground: true })).toBe("backgrounded");
    expect(getToolActivityStatus({ toolUseId: "b", toolName: "B", input: {}, done: false })).toBe("running");
    expect(getToolActivityStatus({ toolUseId: "c", toolName: "C", input: {}, done: true, isError: true })).toBe("error");
    expect(getToolActivityStatus({ toolUseId: "d", toolName: "D", input: {}, done: true })).toBe("completed");
  });
});
