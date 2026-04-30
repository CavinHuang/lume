import { describe, expect, test } from "bun:test";
import { projectAssistantMessageFinalEvent, projectRunStateToRunEvents } from "./run-item-events";
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

describe("projectRunStateToRunEvents", () => {
  test("projects run items into stable UI run events", () => {
    const run = baseRun({
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

    expect(projectRunStateToRunEvents(run)).toEqual([
      { type: "user_message_submitted", text: "hello", createdAt: "2026-04-30T00:00:00.000Z" },
      {
        type: "tool_call_started",
        item: expect.objectContaining({ id: "tool-1", toolName: "Read" })
      },
      {
        type: "tool_call_completed",
        item: expect.objectContaining({ toolCallId: "tool-1", output: "contents" })
      },
      { type: "assistant_delta", text: "done" },
      {
        type: "run_completed",
        result: { status: "completed", finalOutput: "done" }
      }
    ]);
  });

  test("uses stream text only when no final assistant message exists", () => {
    expect(projectRunStateToRunEvents(baseRun({
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
    }))).toContainEqual({ type: "assistant_delta", text: "streaming" });

    expect(projectRunStateToRunEvents(baseRun({
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
    }))).not.toContainEqual({ type: "assistant_delta", text: "duplicate" });
  });

  test("projects thinking separately and ignores duplicated legacy partial text", () => {
    expect(projectRunStateToRunEvents(baseRun({
      status: "running",
      generatedItems: [
        {
          type: "model_stream",
          id: "stream-thinking",
          event: {
            type: "stream_event",
            event: { delta: { type: "thinking_delta", thinking: "think" } }
          },
          createdAt: "2026-04-30T00:00:01.000Z"
        },
        {
          type: "model_stream",
          id: "legacy-partial",
          event: {
            type: "partial_message",
            partial: { type: "text", text: "duplicate" }
          },
          createdAt: "2026-04-30T00:00:02.000Z"
        },
        {
          type: "model_stream",
          id: "stream-text",
          event: {
            type: "stream_event",
            event: { delta: { type: "text_delta", text: "text" } }
          },
          createdAt: "2026-04-30T00:00:03.000Z"
        }
      ]
    }))).toEqual([
      { type: "user_message_submitted", text: "hello", createdAt: "2026-04-30T00:00:00.000Z" },
      { type: "assistant_thinking_delta", text: "think" },
      { type: "assistant_delta", text: "text" }
    ]);
  });

  test("preserves whitespace-only stream deltas because markdown depends on them", () => {
    expect(projectRunStateToRunEvents(baseRun({
      status: "running",
      generatedItems: [
        {
          type: "model_stream",
          id: "stream-heading",
          event: {
            type: "stream_event",
            event: { delta: { type: "text_delta", text: "文件操作" } }
          },
          createdAt: "2026-04-30T00:00:01.000Z"
        },
        {
          type: "model_stream",
          id: "stream-break",
          event: {
            type: "stream_event",
            event: { delta: { type: "text_delta", text: "\n\n" } }
          },
          createdAt: "2026-04-30T00:00:02.000Z"
        },
        {
          type: "model_stream",
          id: "stream-list-item",
          event: {
            type: "stream_event",
            event: { delta: { type: "text_delta", text: "- 读取文件" } }
          },
          createdAt: "2026-04-30T00:00:03.000Z"
        }
      ]
    }))).toEqual([
      { type: "user_message_submitted", text: "hello", createdAt: "2026-04-30T00:00:00.000Z" },
      { type: "assistant_delta", text: "文件操作" },
      { type: "assistant_delta", text: "\n\n" },
      { type: "assistant_delta", text: "- 读取文件" }
    ]);
  });

  test("does not project internal runtime continuation runs into the chat transcript", () => {
    expect(projectRunStateToRunEvents(baseRun({
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
        },
        {
          type: "tool_call",
          id: "tool-continuation",
          toolName: "Read",
          input: { file_path: "story.txt" },
          parentAgentId: "runtime-core",
          status: "pending",
          createdAt: "2026-04-30T00:00:02.000Z"
        }
      ]
    }))).toEqual([]);
  });

  test("filters whitespace-only thinking stream deltas because they create empty thinking blocks", () => {
    expect(projectRunStateToRunEvents(baseRun({
      status: "running",
      generatedItems: [
        {
          type: "model_stream",
          id: "stream-text-a",
          event: {
            type: "stream_event",
            event: { delta: { type: "text_delta", text: "快乐" } }
          },
          createdAt: "2026-04-30T00:00:01.000Z"
        },
        {
          type: "model_stream",
          id: "stream-thinking-space",
          event: {
            type: "stream_event",
            event: { delta: { type: "thinking_delta", thinking: "\n" } }
          },
          createdAt: "2026-04-30T00:00:02.000Z"
        },
        {
          type: "model_stream",
          id: "stream-text-b",
          event: {
            type: "stream_event",
            event: { delta: { type: "text_delta", text: "故事" } }
          },
          createdAt: "2026-04-30T00:00:03.000Z"
        }
      ]
    }))).toEqual([
      { type: "user_message_submitted", text: "hello", createdAt: "2026-04-30T00:00:00.000Z" },
      { type: "assistant_delta", text: "快乐" },
      { type: "assistant_delta", text: "故事" }
    ]);
  });

  test("projects final assistant content as a replacement event", () => {
    expect(projectAssistantMessageFinalEvent({
      type: "assistant_message",
      id: "assistant-1",
      content: [
        { type: "thinking", thinking: "think" },
        { type: "text", text: "- first\n- second" }
      ],
      createdAt: "2026-04-30T00:00:01.000Z"
    })).toEqual({
      type: "assistant_message_final",
      blocks: [
        { type: "thinking", text: "think" },
        { type: "text", text: "- first\n- second" }
      ]
    });
  });

  test("projects subagent and handoff run items for runtime history", () => {
    const events = projectRunStateToRunEvents(baseRun({
      status: "running",
      generatedItems: [
        {
          type: "subagent",
          id: "subagent-item-1",
          runId: "subagent-run-1",
          parentRunId: "run-1",
          task: "Review runtime boundaries",
          status: "running",
          childThreadId: "child-thread",
          createdAt: "2026-04-30T00:00:01.000Z"
        },
        {
          type: "handoff",
          id: "handoff-1",
          fromAgentId: "root",
          toAgentId: "reviewer",
          status: "accepted",
          createdAt: "2026-04-30T00:00:02.000Z"
        }
      ]
    }));

    expect(events).toContainEqual({
      type: "subagent_updated",
      item: expect.objectContaining({ runId: "subagent-run-1", status: "running" })
    });
    expect(events).toContainEqual({
      type: "handoff_updated",
      item: expect.objectContaining({ fromAgentId: "root", toAgentId: "reviewer", status: "accepted" })
    });
  });
});
