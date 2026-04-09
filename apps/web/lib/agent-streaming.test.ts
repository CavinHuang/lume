import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@lume/shared";
import { applySdkMessage, type AgentStreamState } from "./agent-streaming";

function createState(): AgentStreamState {
  return {
    running: true,
    content: "",
    reasoning: "",
    toolActivities: []
  };
}

describe("agent-streaming", () => {
  test("assistant 消息应避免和已有 content 重复拼接", () => {
    const state = createState();
    const afterDelta = applySdkMessage(state, {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "Hello "
        }
      }
    } as unknown as SDKMessage);

    const afterAssistant = applySdkMessage(afterDelta, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }]
      }
    } as SDKMessage);

    expect(afterAssistant.content).toBe("Hello world");
  });

  test("tool_use/tool_result 应创建并完成 tool activity", () => {
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const afterStart = applySdkMessage(createState(), {
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
      } as unknown as SDKMessage);
      now = 1_975;
      const afterResult = applySdkMessage(afterStart, {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "ok"
          }]
        }
      } as unknown as SDKMessage);

      expect(afterResult.toolActivities).toEqual([{
        toolUseId: "tool-1",
        toolName: "Read",
        input: { path: "README.md" },
        parentToolUseId: undefined,
        startedAt: 1_000,
        done: true,
        isError: false,
        result: "ok",
        elapsedMs: 975
      }]);
    } finally {
      Date.now = realNow;
    }
  });

  test("独立 tool_result 消息也应完成 tool activity", () => {
    const realNow = Date.now;
    let now = 2_000;
    Date.now = () => now;
    try {
      const afterStart = applySdkMessage(createState(), {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "tool-standalone",
            name: "Read",
            input: { path: "README.md" }
          }]
        }
      } as unknown as SDKMessage);
      now = 2_250;
      const afterResult = applySdkMessage(afterStart, {
        type: "tool_result",
        result: {
          tool_use_id: "tool-standalone",
          tool_name: "Read",
          output: "done"
        }
      } as unknown as SDKMessage);

      expect(afterResult.toolActivities).toEqual([{
        toolUseId: "tool-standalone",
        toolName: "Read",
        input: { path: "README.md" },
        parentToolUseId: undefined,
        startedAt: 2_000,
        done: true,
        isError: false,
        result: "done",
        elapsedMs: 250
      }]);
    } finally {
      Date.now = realNow;
    }
  });

  test("thinking delta 与 assistant thinking 应独立累积", () => {
    const afterReasoningDelta = applySdkMessage(createState(), {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: {
          type: "thinking_delta",
          thinking: "先检查"
        }
      }
    } as unknown as SDKMessage);
    const afterAssistant = applySdkMessage(afterReasoningDelta, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "先检查上下文" }]
      }
    } as unknown as SDKMessage);

    expect(afterAssistant.reasoning).toBe("先检查上下文");
    expect(afterAssistant.content).toBe("");
  });

  test("stream_event 的 tool_use start/input_json_delta 应流式更新工具块输入", () => {
    const afterToolStart = applySdkMessage(createState(), {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tool-stream-1",
          name: "WebSearch"
        }
      }
    } as unknown as SDKMessage);

    const afterToolDelta = applySdkMessage(afterToolStart, {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: "{\"query\":\"lume release\"}"
        }
      }
    } as unknown as SDKMessage);

    expect(afterToolDelta.toolActivities).toEqual([{
      toolUseId: "tool-stream-1",
      toolName: "WebSearch",
      input: { query: "lume release" },
      parentToolUseId: undefined,
      startedAt: expect.any(Number),
      done: false,
      inputJsonBuffer: "{\"query\":\"lume release\"}"
    }]);
  });

  test("streamlined_text 应实时更新 content", () => {
    const afterStreamlined = applySdkMessage(createState(), {
      type: "streamlined_text",
      text: "第一段",
      session_id: "session-1"
    } as unknown as SDKMessage);
    const afterSecond = applySdkMessage(afterStreamlined, {
      type: "streamlined_text",
      text: "第一段第二段",
      session_id: "session-1"
    } as unknown as SDKMessage);

    expect(afterSecond.content).toBe("第一段第二段");
  });

  test("tool_progress/tool_use_summary 应驱动工具块流式状态", () => {
    const afterProgress = applySdkMessage(createState(), {
      type: "tool_progress",
      tool_use_id: "tool-p-1",
      tool_name: "Read",
      parent_tool_use_id: null,
      elapsed_time_seconds: 2,
      session_id: "session-1"
    } as unknown as SDKMessage);

    expect(afterProgress.toolActivities).toEqual([{
      toolUseId: "tool-p-1",
      toolName: "Read",
      input: {},
      parentToolUseId: undefined,
      taskId: undefined,
      startedAt: expect.any(Number),
      elapsedSeconds: 2,
      elapsedMs: 2000,
      done: false
    }]);

    const afterSummary = applySdkMessage(afterProgress, {
      type: "tool_use_summary",
      summary: "读取完成",
      preceding_tool_use_ids: ["tool-p-1"],
      session_id: "session-1"
    } as unknown as SDKMessage);

    expect(afterSummary.toolActivities).toEqual([{
      toolUseId: "tool-p-1",
      toolName: "Read",
      input: {},
      parentToolUseId: undefined,
      taskId: undefined,
      startedAt: expect.any(Number),
      elapsedSeconds: 2,
      elapsedMs: 2000,
      done: true,
      result: "读取完成"
    }]);
  });
});
