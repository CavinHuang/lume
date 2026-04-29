import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@lume/shared";
import { mapSdkMessageToRunEvents } from "./run-events";

describe("LumeRunEvent SDKMessage adapter", () => {
  test("maps assistant text blocks to assistant_delta events", () => {
    const events = mapSdkMessageToRunEvents({
      type: "assistant",
      uuid: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: " world" }
        ]
      }
    } as SDKMessage);

    expect(events).toEqual([{ type: "assistant_delta", text: "hello world" }]);
  });

  test("maps assistant tool use blocks to tool_call_started events", () => {
    const events = mapSdkMessageToRunEvents({
      type: "assistant",
      parent_tool_use_id: "parent-tool",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "tool-1",
          name: "Bash",
          input: { command: "pwd" }
        }]
      }
    } as SDKMessage, { currentAgentId: "agent-1" }, () => "2026-01-01T00:00:00.000Z");

    expect(events).toEqual([{
      type: "tool_call_started",
      item: {
        type: "tool_call",
        id: "tool-1",
        toolName: "Bash",
        input: { command: "pwd" },
        parentAgentId: "agent-1",
        parentToolCallId: "parent-tool",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    }]);
  });

  test("maps tool results to tool_call_completed events", () => {
    const events = mapSdkMessageToRunEvents({
      type: "tool_result",
      result: {
        tool_use_id: "tool-1",
        tool_name: "Read",
        output: "file content"
      }
    } as SDKMessage, undefined, () => "2026-01-01T00:00:00.000Z");

    expect(events).toEqual([{
      type: "tool_call_completed",
      item: {
        type: "tool_result",
        id: "tool-1-result",
        toolCallId: "tool-1",
        toolName: "Read",
        output: "file content",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    }]);
  });

  test("maps result messages to terminal run events", () => {
    expect(mapSdkMessageToRunEvents({
      type: "result",
      subtype: "success",
      result: "done"
    } as SDKMessage)).toEqual([{
      type: "run_completed",
      result: {
        status: "completed",
        finalOutput: "done"
      }
    }]);

    expect(mapSdkMessageToRunEvents({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["boom"]
    } as SDKMessage)).toEqual([{
      type: "run_failed",
      error: {
        code: "error_during_execution",
        message: "boom"
      }
    }]);
  });
});
