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

  test("projects model context window into run started events", () => {
    expect(projectRunStateToRuntimeEvents(baseRun({
      model: {
        provider: "openai",
        modelId: "gpt-test",
        contextWindow: 200_000
      }
    }))[0]).toMatchObject({
      type: "run.started",
      model: expect.objectContaining({
        contextWindow: 200_000
      })
    });
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

  test("projects persisted plan previews into product runtime events", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      status: "running",
      generatedItems: [{
        type: "plan_preview",
        id: "plan:plan-1",
        contractId: "plan-1",
        title: "Ship runtime",
        summary: "Preview the plan",
        markdown: "# Ship runtime\n\n## Steps\n1. Inspect",
        planFilePath: "plans/plan-1.md",
        planVerified: true,
        stepCount: 1,
        createdAt: "2026-04-30T00:00:04.000Z"
      } as any]
    }));

    expect(events).toContainEqual({
      id: "run-1:plan:plan-1:plan.preview",
      type: "plan.preview",
      threadId: "thread-1",
      runId: "run-1",
      createdAt: "2026-04-30T00:00:04.000Z",
      contractId: "plan-1",
      title: "Ship runtime",
      summary: "Preview the plan",
      markdown: "# Ship runtime\n\n## Steps\n1. Inspect",
      planFilePath: "plans/plan-1.md",
      planVerified: true,
      stepCount: 1
    });
  });

  test("projects compaction and usage system events into product runtime events", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      generatedItems: [
        {
          type: "system_event",
          id: "compact-started",
          name: "context_compaction_started",
          payload: {
            type: "system",
            subtype: "context_compaction_started",
            compact_metadata: {
              trigger: "auto",
              pre_tokens: 900,
              policy: "kernel-v1",
              source: "agent-runtime-kernel",
              context_window: 1000,
              budget: {
                totalTokens: 1000,
                usedTokens: 900,
                remainingTokens: 100,
                sections: {
                  system: 120,
                  memory: 80,
                  session: 650,
                  toolSchemas: 30,
                  reservedOutput: 50
                }
              }
            }
          },
          createdAt: "2026-04-30T00:00:01.000Z"
        },
        {
          type: "system_event",
          id: "compact-done",
          name: "compact_boundary",
          payload: {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: {
              trigger: "auto",
              pre_tokens: 900,
              post_tokens: 300,
              summary: "kept the important decisions",
              policy: "kernel-v1",
              source: "agent-runtime-kernel",
              source_message_ids: ["msg-1"],
              memory_flush_job_id: "memory.flush:thread-1:compact_boundary",
              context_window: 1000,
              budget: {
                totalTokens: 1000,
                usedTokens: 900,
                remainingTokens: 100,
                sections: {
                  system: 120,
                  memory: 80,
                  session: 650,
                  toolSchemas: 30,
                  reservedOutput: 50
                }
              }
            }
          },
          createdAt: "2026-04-30T00:00:02.000Z"
        },
        {
          type: "system_event",
          id: "result",
          name: "result",
          payload: {
            type: "result",
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 2
            },
            modelUsage: {
              "gpt-test": {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadInputTokens: 3,
                cacheCreationInputTokens: 2,
                costUSD: 0.01,
                contextWindow: 1000
              }
            },
            total_cost_usd: 0.01
          },
          createdAt: "2026-04-30T00:00:03.000Z"
        }
      ]
    }));

    expect(events).toContainEqual(expect.objectContaining({
      id: "run-1:compact-started:context.compaction.started",
      type: "context.compaction.started",
      trigger: "auto",
      preTokens: 900,
      contextWindow: 1000,
      budget: expect.objectContaining({
        totalTokens: 1000,
        sections: expect.objectContaining({ session: 650 })
      }),
      policy: "kernel-v1",
      source: "agent-runtime-kernel"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      id: "run-1:compact-done:context.compaction.completed",
      type: "context.compaction.completed",
      trigger: "auto",
      preTokens: 900,
      postTokens: 300,
      contextWindow: 1000,
      budget: expect.objectContaining({
        totalTokens: 1000,
        sections: expect.objectContaining({ session: 650 })
      }),
      summary: "kept the important decisions",
      memoryFlushJobId: "memory.flush:thread-1:compact_boundary"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      id: "run-1:result:usage.updated",
      type: "usage.updated",
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 5,
      usageRecords: [
        {
          callerLabel: "gpt-test",
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 5,
          costUSD: 0.01
        }
      ],
      totalTokens: 20,
      contextWindow: 1000,
      costUSD: 0.01
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
