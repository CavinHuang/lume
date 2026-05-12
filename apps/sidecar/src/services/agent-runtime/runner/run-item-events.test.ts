import { describe, expect, test } from "bun:test";
import {
  projectAssistantMessageFinalRuntimeEvent,
  projectRunStateToRuntimeEvents
} from "./run-item-events";
import type { LumeRunState } from "./run-state";

function baseRun(overrides: Partial<LumeRunState> = {}): LumeRunState {
  return {
    version: 1,
    runId: "run-1",
    threadId: "thread-1",
    rootAgentId: "runtime-core",
    currentAgentId: "runtime-core",
    status: "completed",
    input: { userMessage: "hello" },
    generatedItems: [],
    pendingInterruptions: [],
    approvals: { alwaysAllowedTools: [] },
    traceId: "trace-1",
    model: { provider: "openai", modelId: "gpt-test" },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
    ...overrides
  };
}

describe("projectRunStateToRuntimeEvents", () => {
  test("projects kernel run facts into product runtime events", () => {
    const run = baseRun({
      runId: "run-runtime-1",
      threadId: "thread-runtime-1",
      status: "completed",
      generatedItems: [
        {
          type: "tool_call",
          id: "tool-1",
          toolName: "Read",
          input: { file_path: "README.md" },
          parentAgentId: "runtime-core",
          status: "pending",
          createdAt: "2026-04-30T00:00:01.000Z"
        },
        {
          type: "tool_result",
          id: "tool-1-result",
          toolCallId: "tool-1",
          toolName: "Read",
          output: "contents",
          createdAt: "2026-04-30T00:00:02.000Z"
        },
        {
          type: "assistant_message",
          id: "assistant-1",
          content: [{ type: "text", text: "done" }],
          createdAt: "2026-04-30T00:00:03.000Z"
        }
      ]
    });

    expect(projectRunStateToRuntimeEvents(run)).toEqual([
      expect.objectContaining({
        type: "run.started",
        threadId: "thread-runtime-1",
        runId: "run-runtime-1"
      }),
      expect.objectContaining({
        type: "message.user.submitted",
        text: "hello",
        threadId: "thread-runtime-1",
        runId: "run-runtime-1"
      }),
      expect.objectContaining({
        type: "tool.started",
        toolCallId: "tool-1",
        toolName: "Read"
      }),
      expect.objectContaining({
        type: "tool.completed",
        toolCallId: "tool-1",
        toolName: "Read",
        resultPreview: "contents"
      }),
      expect.objectContaining({
        type: "assistant.delta",
        delta: "done"
      }),
      expect.objectContaining({
        type: "run.completed",
        finalOutput: "done"
      })
    ]);
  });

  test("uses stream deltas only when no final assistant message exists", () => {
    expect(projectRunStateToRuntimeEvents(baseRun({
      status: "running",
      generatedItems: [{
        type: "model_stream",
        id: "stream-1",
        event: {
          type: "stream_event",
          event: { delta: { type: "text_delta", text: "streaming" } }
        },
        createdAt: "2026-04-30T00:00:01.000Z"
      }]
    }))).toContainEqual(expect.objectContaining({ type: "assistant.delta", delta: "streaming" }));

    expect(projectRunStateToRuntimeEvents(baseRun({
      generatedItems: [
        {
          type: "model_stream",
          id: "stream-1",
          event: {
            type: "stream_event",
            event: { delta: { type: "text_delta", text: "duplicate" } }
          },
          createdAt: "2026-04-30T00:00:01.000Z"
        },
        {
          type: "assistant_message",
          id: "assistant-1",
          content: [{ type: "text", text: "final" }],
          createdAt: "2026-04-30T00:00:02.000Z"
        }
      ]
    }))).not.toContainEqual(expect.objectContaining({ type: "assistant.delta", delta: "duplicate" }));
  });

  test("does not project internal runtime continuation runs into product events", () => {
    expect(projectRunStateToRuntimeEvents(baseRun({
      input: {
        userMessage: "继续执行之前因人工交互暂停的任务。",
        messageMetadata: {
          runtimeContinuation: {
            sourceRunId: "previous-run"
          }
        }
      },
      generatedItems: [
        {
          type: "assistant_message",
          id: "assistant-continuation",
          content: [{ type: "text", text: "internal continuation output" }],
          createdAt: "2026-04-30T00:00:01.000Z"
        }
      ]
    }))).toEqual([]);
  });

  test("hides plan control input while keeping execution output visible", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      input: {
        userMessage: "请按顺序自动继续执行当前未完成计划。",
        messageMetadata: {
          hiddenFromChat: true,
          planControlEvent: "continue_plan"
        }
      },
      generatedItems: [{
        type: "assistant_message",
        id: "assistant-plan-output",
        content: [{ type: "text", text: "plan execution output" }],
        createdAt: "2026-04-30T00:00:01.000Z"
      }]
    }));

    expect(events).not.toContainEqual(expect.objectContaining({ type: "message.user.submitted" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant.delta",
      delta: "plan execution output"
    }));
  });
});

describe("projectAssistantMessageFinalRuntimeEvent", () => {
  test("projects final assistant content as a replacement runtime event", () => {
    expect(projectAssistantMessageFinalRuntimeEvent(baseRun(), {
      type: "assistant_message",
      id: "assistant-1",
      content: [
        { type: "thinking", thinking: "think" },
        { type: "text", text: "- first\n- second" }
      ],
      createdAt: "2026-04-30T00:00:01.000Z"
    })).toEqual({
      id: "run-1:assistant-1:assistant.final",
      type: "assistant.final",
      threadId: "thread-1",
      runId: "run-1",
      createdAt: "2026-04-30T00:00:01.000Z",
      blocks: [
        { type: "thinking", text: "think" },
        { type: "text", text: "- first\n- second" }
      ]
    });
  });
});
