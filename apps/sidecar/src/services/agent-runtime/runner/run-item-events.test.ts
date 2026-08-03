import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  projectAssistantMessageFinalRuntimeEvent,
  projectRunItemToRuntimeEvents,
  projectRunStateToRuntimeEvents
} from "./run-item-events";
import type { LumeRunState } from "./run-state";
import { getAgentFileContextArtifactsPath } from "../../infra/config-paths";

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
  test("projects a parent background task completion as a dedicated runtime event", () => {
    const events = projectRunItemToRuntimeEvents(baseRun(), {
      type: "system_event",
      id: "task-notification-1",
      name: "task_notification",
      payload: {
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        summary: "检查已完成",
        usage: { total_tokens: 12, tool_uses: 2, duration_ms: 80 }
      },
      createdAt: "2026-04-30T00:00:02.000Z"
    }, {
      includeAssistantText: true,
      includeAssistantThinking: true,
      includeModelStreamText: true
    });

    expect(events).toEqual([expect.objectContaining({
      id: "background-task:thread-1:task-1:completed",
      type: "background.task.completed",
      runId: "background-task:task-1",
      taskId: "task-1",
      status: "completed",
      summary: "检查已完成",
      usage: { totalTokens: 12, toolUses: 2, durationMs: 80 }
    })]);
  });

  test("does not duplicate subagent completion as a parent background event", () => {
    const events = projectRunItemToRuntimeEvents(baseRun(), {
      type: "system_event",
      id: "task-notification-subagent-1",
      name: "task_notification",
      payload: {
        task_id: "task-1",
        subagent_run_id: "subagent-1",
        status: "completed"
      },
      createdAt: "2026-04-30T00:00:02.000Z"
    }, {
      includeAssistantText: true,
      includeAssistantThinking: true,
      includeModelStreamText: true
    });

    expect(events).toEqual([]);
  });

  test("projects delayed LSP diagnostics without a chat status item", () => {
    const events = projectRunItemToRuntimeEvents(baseRun(), {
      type: "system_event",
      id: "lsp-1",
      name: "lsp_diagnostics",
      payload: {
        tool_use_id: "edit-1",
        file_path: "src/index.ts",
        mutation_version: 2,
        sha256: "abc",
        delayed: true,
        diagnostics: {
          servers: ["typescript-language-server"],
          total: 1,
          errors: 1,
          warnings: 0,
          truncated: false,
          items: []
        }
      },
      createdAt: "2026-04-30T00:00:02.000Z"
    }, {
      includeAssistantText: true,
      includeAssistantThinking: true,
      includeModelStreamText: true
    });
    expect(events).toEqual([expect.objectContaining({
      type: "lsp.diagnostics.updated",
      toolUseId: "edit-1",
      mutationVersion: 2,
      delayed: true
    })]);
  });

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

  test("projects message attachments onto user submitted events", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      input: {
        userMessage: "summarize this",
        messageAttachments: [{
          id: "att-1",
          filename: "brief.md",
          mediaType: "text/markdown",
          size: 2048,
          threadPath: "docs/brief.md"
        }]
      } as LumeRunState["input"]
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "message.user.submitted",
      text: "summarize this",
      attachments: [{
        id: "att-1",
        filename: "brief.md",
        mediaType: "text/markdown",
        size: 2048,
        threadPath: "docs/brief.md"
      }]
    }));
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

  test("preserves subagent ownership on projected runtime events", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      status: "running",
      generatedItems: [
        {
          type: "model_stream",
          id: "stream-subagent-1",
          event: {
            type: "stream_event",
            event: { delta: { type: "thinking_delta", thinking: "writer thinking" } },
            subagent_run_id: "subagent-run-1",
            parent_tool_use_id: "agent-tool-1"
          },
          createdAt: "2026-04-30T00:00:01.000Z"
        },
        {
          type: "assistant_message",
          id: "assistant-subagent-1",
          content: [{ type: "text", text: "writer output" }],
          subagentRunId: "subagent-run-1",
          parentToolCallId: "agent-tool-1",
          createdAt: "2026-04-30T00:00:02.000Z"
        } as any,
        {
          type: "tool_call",
          id: "skill-tool-1",
          toolName: "Skill",
          input: { skill: "writing-plans" },
          parentAgentId: "runtime-core",
          parentToolCallId: "agent-tool-1",
          status: "pending",
          createdAt: "2026-04-30T00:00:03.000Z"
        }
      ]
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant.delta",
      delta: "writer output",
      subagentRunId: "subagent-run-1",
      parentToolUseId: "agent-tool-1"
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.started",
      toolCallId: "skill-tool-1",
      parentToolUseId: "agent-tool-1"
    }));
  });

  test("infers subagent ownership for old assistant items from the adjacent child tool call", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      status: "running",
      generatedItems: [
        {
          type: "assistant_message",
          id: "assistant-subagent-old",
          content: [{ type: "text", text: "old writer output" }],
          createdAt: "2026-04-30T00:00:02.000Z"
        },
        {
          type: "tool_call",
          id: "skill-tool-old",
          toolName: "Skill",
          input: { skill: "writing-plans" },
          parentAgentId: "runtime-core",
          parentToolCallId: "agent-tool-1",
          status: "pending",
          createdAt: "2026-04-30T00:00:02.000Z"
        }
      ]
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant.delta",
      delta: "old writer output",
      parentToolUseId: "agent-tool-1"
    }));
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
          id: "compact-progress",
          name: "context_compaction_progress",
          payload: {
            type: "system",
            subtype: "context_compaction_progress",
            compact_metadata: {
              trigger: "auto",
              pre_tokens: 900,
              stage: "summarizing",
              progress: 45,
              message: "正在生成上下文摘要",
              policy: "kernel-v1",
              source: "agent-runtime-kernel",
              context_window: 1000
            }
          },
          createdAt: "2026-04-30T00:00:01.500Z"
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
              outcome: "succeeded",
              retained_tokens: 20_000,
              retained_message_count: 4,
              source_message_ids: ["msg-1"],
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
            contextUsage: {
              source: "provider",
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 2,
              totalTokens: 20,
              estimatedTailTokens: 0,
              contextWindow: 1000,
              contextWindowSource: "model"
            },
            billingUsage: {
              cumulative: {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadInputTokens: 3,
                cacheCreationInputTokens: 2,
                totalTokens: 20
              },
              latestRecord: {
                callerLabel: "Turn 1",
                model: "gpt-test",
                inputTokens: 6,
                outputTokens: 2,
                cacheReadInputTokens: 1,
                cacheCreationInputTokens: 1,
                costUSD: 0.004,
                totalTokens: 10,
                turn: 1,
                usageIdentity: {
                  threadId: "thread-1",
                  callerKind: "conversation",
                  turn: 1
                }
              },
              records: [
                {
                  callerLabel: "Turn 1",
                  model: "gpt-test",
                  inputTokens: 6,
                  outputTokens: 2,
                  cacheReadInputTokens: 1,
                  cacheCreationInputTokens: 1,
                  totalTokens: 10,
                  costUSD: 0.004,
                  turn: 1,
                  usageIdentity: {
                    threadId: "thread-1",
                    callerKind: "conversation",
                    turn: 1
                  }
                },
                {
                  callerLabel: "Turn 2",
                  model: "gpt-test",
                  inputTokens: 4,
                  outputTokens: 3,
                  cacheReadInputTokens: 2,
                  cacheCreationInputTokens: 1,
                  totalTokens: 10,
                  costUSD: 0.006,
                  turn: 2,
                  usageIdentity: {
                    threadId: "thread-1",
                    callerKind: "conversation",
                    turn: 2
                  }
                }
              ],
              totalCostUSD: 0.01
            }
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
      id: "run-1:compact-progress:context.compaction.progress",
      type: "context.compaction.progress",
      trigger: "auto",
      preTokens: 900,
      contextWindow: 1000,
      stage: "summarizing",
      progress: 45,
      message: "正在生成上下文摘要",
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
      outcome: "succeeded",
      retainedTokens: 20_000,
      retainedMessageCount: 4
    }));
    expect(events).toContainEqual(expect.objectContaining({
      id: "run-1:result:usage.updated",
      type: "usage.updated",
      scope: "main",
      context: {
        source: "provider",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        cachedTokens: 3,
        totalTokens: 20,
        estimatedTailTokens: 0,
        contextWindow: 1000,
        contextWindowSource: "model"
      },
      billing: {
        cumulative: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          cachedTokens: 3,
          totalTokens: 20
        },
        latestRecord: expect.objectContaining({
          callerLabel: "Turn 1",
          inputTokens: 6,
          outputTokens: 2,
          cachedTokens: 1
        }),
        records: [
        expect.objectContaining({
          callerLabel: "Turn 1",
          callerKind: "conversation",
          model: "gpt-test",
          turn: 1,
          inputTokens: 6,
          outputTokens: 2,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 1,
          cachedTokens: 1,
          costUSD: 0.004
        }),
        expect.objectContaining({
          callerLabel: "Turn 2",
          callerKind: "conversation",
          model: "gpt-test",
          turn: 2,
          inputTokens: 4,
          outputTokens: 3,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          cachedTokens: 2,
          costUSD: 0.006
        })
        ],
        totalCostUSD: 0.01
      }
    }));
  });

  test("signs tool result artifacts with a renderer-safe session FileRef", () => {
    const fileContextId = "runtime-result-ref";
    const artifactPath = join(getAgentFileContextArtifactsPath(fileContextId), "jobs", "output.log");
    const events = projectRunStateToRuntimeEvents(baseRun({
      fileReferenceBinding: { fileContextId },
      generatedItems: [{
        type: "tool_result",
        id: "tool-result",
        toolCallId: "tool-1",
        toolName: "Bash",
        output: "done",
        execution: {
          version: 2,
          outcome: "succeeded",
          durationMs: 10,
          command: "echo done",
          shell: "powershell",
          resultRef: { kind: "file", path: artifactPath, size: 4, mimeType: "text/plain" },
          terminationReason: "completed",
        },
        createdAt: "2026-04-30T00:00:02.000Z",
      }],
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.completed",
      resultRef: expect.objectContaining({
        path: artifactPath,
        fileRef: {
          source: "session",
          scopeId: fileContextId,
          relativePath: "artifacts/jobs/output.log",
        },
      }),
    }));
  });

  test("does not sign result files outside the bound artifact directory", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      fileReferenceBinding: { fileContextId: "runtime-result-ref-outside" },
      generatedItems: [{
        type: "tool_result",
        id: "tool-result",
        toolCallId: "tool-1",
        toolName: "Bash",
        output: "done",
        execution: {
          version: 2,
          outcome: "succeeded",
          durationMs: 10,
          command: "echo done",
          shell: "powershell",
          resultRef: { kind: "file", path: join(process.cwd(), "outside.log"), size: 4 },
          terminationReason: "completed",
        },
        createdAt: "2026-04-30T00:00:02.000Z",
      }],
    }));
    const completed = events.find((event) => event.type === "tool.completed");

    expect(completed?.type === "tool.completed" ? completed.resultRef?.fileRef : undefined).toBeUndefined();
  });

  test("fails closed for malformed historical file bindings", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      fileReferenceBinding: { fileContextId: "../invalid" },
      generatedItems: [{
        type: "tool_result",
        id: "tool-result",
        toolCallId: "tool-1",
        toolName: "Bash",
        output: "done",
        execution: {
          version: 2,
          outcome: "succeeded",
          durationMs: 10,
          command: "echo done",
          shell: "powershell",
          resultRef: { kind: "file", path: join(process.cwd(), "outside.log"), size: 4 },
          terminationReason: "completed",
        },
        createdAt: "2026-04-30T00:00:02.000Z",
      }],
    }));
    const completed = events.find((event) => event.type === "tool.completed");

    expect(completed?.type === "tool.completed" ? completed.resultRef?.fileRef : undefined).toBeUndefined();
  });

  test("projects persisted Advisor reviews into product runtime events", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      generatedItems: [{
        type: "system_event",
        id: "advisor-1",
        name: "advisor_reviewed",
        payload: {
          severity: "concern",
          summary: "可能遗漏边界条件",
          details: "建议补充空输入检查",
          modelRef: "openai/gpt-5-mini",
          durationMs: 1234
        },
        createdAt: "2026-04-30T00:00:01.000Z"
      }]
    }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "advisor.reviewed",
      severity: "concern",
      summary: "可能遗漏边界条件",
      details: "建议补充空输入检查",
      modelRef: "openai/gpt-5-mini",
      durationMs: 1234
    }));
  });

  test("does not project legacy usage fields as context usage", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      generatedItems: [{
        type: "system_event",
        id: "legacy-result",
        name: "result",
        payload: {
          type: "result",
          usage: {
            input_tokens: 10,
            output_tokens: 5
          },
          modelUsage: {
            "gpt-test": {
              inputTokens: 10,
              outputTokens: 5,
              contextWindow: 1000
            }
          }
        },
        createdAt: "2026-04-30T00:00:03.000Z"
      }]
    }));

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "usage.updated"
    }));
  });

  test("projects subagent result usage without treating it as main scope", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      generatedItems: [{
        type: "system_event",
        id: "subagent-result",
        name: "result",
        payload: {
          type: "result",
          subagent_run_id: "child-run-1",
          parent_tool_use_id: "tool-agent-1",
          contextUsage: {
            source: "provider",
            inputTokens: 20,
            outputTokens: 6,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalTokens: 26,
            estimatedTailTokens: 0,
            contextWindow: 200000,
            contextWindowSource: "model"
          },
          billingUsage: {
            cumulative: {
              inputTokens: 20,
              outputTokens: 6,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              totalTokens: 26
            },
            latestRecord: {
              callerLabel: "Subagent",
              model: "gpt-test",
              inputTokens: 20,
              outputTokens: 6,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              totalTokens: 26,
              usageIdentity: {
                threadId: "child-run-1",
                parentThreadId: "thread-1",
                subagentRunId: "child-run-1",
                callerKind: "subagent"
              }
            },
            records: [],
            totalCostUSD: 0
          }
        },
        createdAt: "2026-04-30T00:00:03.000Z"
      }]
    }));

    expect(events).toContainEqual(expect.objectContaining({
      id: "run-1:subagent-result:usage.updated",
      type: "usage.updated",
      scope: "subagent",
      subagentRunId: "child-run-1",
      parentToolUseId: "tool-agent-1"
    }));
  });

  test("projects persisted memory context usage into product runtime events", () => {
    const events = projectRunStateToRuntimeEvents(baseRun({
      generatedItems: [{
        type: "system_event",
        id: "memory-context-used",
        name: "memory_context_used",
        payload: {
          items: [{
            id: "mem_1",
            kind: "decision",
            scope: "workspace",
            status: "active",
            citation: "/tmp/memory/entries/mem_1.md",
            reason: "matched memory entry"
          }],
          hidden: true
        },
        createdAt: "2026-04-30T00:00:01.000Z"
      }]
    }));

    expect(events).toContainEqual({
      id: "run-1:memory-context-used:memory.context.used",
      type: "memory.context.used",
      threadId: "thread-1",
      runId: "run-1",
      createdAt: "2026-04-30T00:00:01.000Z",
      items: [{
        id: "mem_1",
        kind: "decision",
        scope: "workspace",
        status: "active",
        citation: "/tmp/memory/entries/mem_1.md",
        reason: "matched memory entry"
      }],
      hidden: true
    });
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
