import { describe, expect, test } from "bun:test"
import { QueryEngine } from "./engine.js"
import { createToolSearchTool } from "./tools/tool-search.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"
import type { SDKMessage, ToolContext } from "./types.js"
import { normalizeProviderUsage } from "./utils/usage.js"
import { SkillRegistry } from "./skills/registry.js"

const structuredCompactionSummary = `## Goal
Continue the current task.

## Constraints & Preferences
- Preserve recent context.

## Progress
### Done
- [x] Summarized old history.

### In Progress
- [ ] Continue.

### Blocked
- (none)

## Key Decisions
- **Retention**: Keep the recent tail.

## Next Steps
1. Continue the task.

## Critical Context
- Recent messages remain verbatim.`

class StaticProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const
  private index = 0
  readonly requests: CreateMessageParams[] = []

  constructor(private readonly responses: CreateMessageResponse[]) {}

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.requests.push(params)
    const response = this.responses[this.index]
    this.index += 1
    if (!response) {
      throw new Error("unexpected provider call")
    }
    return response
  }
}

async function collectResult(engine: QueryEngine) {
  let result: unknown
  for await (const event of engine.submitMessage("run")) {
    if (event.type === "result") {
      result = event
    }
  }
  return result as { subtype: string; is_error: boolean; num_turns: number }
}

async function collectEvents(engine: QueryEngine, prompt = "run") {
  const events: unknown[] = []
  for await (const event of engine.submitMessage(prompt)) {
    events.push(event)
  }
  return events
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms))
}

describe("QueryEngine cancellation", () => {
  test("aborts from an active tool end the turn with an interrupted placeholder", async () => {
    const controller = new AbortController()
    const started = deferred<void>()
    const provider = new StaticProvider([{
      content: [{ type: "tool_use", id: "tool-1", name: "Wait", input: {} }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Wait",
        description: "wait",
        inputSchema: { type: "object", properties: {} },
        async call(_input, context) {
          started.resolve(undefined)
          return new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener("abort", () => reject(new Error("tool aborted")), { once: true })
          })
        },
      }],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      abortSignal: controller.signal,
    })

    const running = collectEvents(engine)
    await started.promise
    controller.abort()

    const events = (await running) as Array<{ type: string; result?: { is_error: boolean; content: string } }>
    expect(provider.requests).toHaveLength(1)
    // Soft abort: the run ends normally with a paired error tool_result.
    const toolResults = events.filter((event) => event.type === "tool_result")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].result?.is_error).toBe(true)
    expect(toolResults[0].result?.content).toContain("interrupted")
    expect(engine.getMessages().at(-1)?.role).toBe("user")
  })
})

describe("QueryEngine turn limits", () => {
  test("executes a persisted approved tool exactly once before the resumed model request", async () => {
    let calls = 0
    let approvals = 0
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "resumed" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls += 1
          return { type: "tool_result", tool_use_id: "", content: "persisted content" }
        },
      }],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => {
        approvals += 1
        return { behavior: "allow" }
      },
      toolContinuations: [
        { toolCall: { id: "tool-resume-1", name: "Read", input: { file_path: "README.md" } } },
      ],
    })

    await collectEvents(engine, "ignored continuation prompt")

    expect(calls).toBe(1)
    expect(approvals).toBe(1)
    expect(provider.requests[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: [expect.objectContaining({ type: "tool_result", tool_use_id: "tool-resume-1" })],
      }),
    ]))
    expect(provider.requests[0]?.messages).not.toContainEqual({
      role: "user",
      content: "ignored continuation prompt",
    })
  })

  test("injects a persisted terminal tool result without executing the tool again", async () => {
    let calls = 0
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "continued from result" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Bash",
        description: "bash",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls += 1
          return { type: "tool_result", tool_use_id: "", content: "should not execute" }
        },
      }],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      toolContinuations: [
        {
          toolCall: { id: "tool-resume-2", name: "Bash", input: { command: "bun test" } },
          toolResult: { type: "tool_result", tool_use_id: "tool-resume-2", content: "2 pass" },
        },
      ],
    })

    await collectEvents(engine)

    expect(calls).toBe(0)
    expect(provider.requests[0]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: [expect.objectContaining({
          type: "tool_result",
          tool_use_id: "tool-resume-2",
          content: "2 pass",
        })],
      }),
    ]))
  })

  test("mixed continuations replay some tools and inject others", async () => {
    let calls = 0
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "mixed resumed" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls += 1
          return { type: "tool_result", tool_use_id: "", content: "replayed" }
        },
      }],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      toolContinuations: [
        { toolCall: { id: "t-inject", name: "Read", input: { file_path: "x" } },
          toolResult: { type: "tool_result", tool_use_id: "t-inject", content: "injected" } },
        { toolCall: { id: "t-replay", name: "Read", input: { file_path: "y" } } },
      ],
    })

    await collectEvents(engine)

    expect(calls).toBe(1) // only t-replay is replayed
    const request = provider.requests[0]?.messages as any[]
    const toolResults = request.flatMap((m) => Array.isArray(m.content) ? m.content : [])
      .filter((c: any) => c.type === "tool_result")
    const ids = toolResults.map((c: any) => c.tool_use_id).sort()
    expect(ids).toEqual(["t-inject", "t-replay"])
    // Array-pairing core semantics: every continuation result must land in the
    // SAME user message (one tool-boundary repair turn, not one per tool).
    const carrierMessages = request.filter(
      (m) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"),
    )
    expect(carrierMessages).toHaveLength(1)
    expect(carrierMessages[0]?.role).toBe("user")
    expect((carrierMessages[0]?.content as any[]).map((c) => c.tool_use_id).sort())
      .toEqual(["t-inject", "t-replay"])
  })

  test("forwards exactly terminal task notifications emitted after a tool call returns", async () => {
    let emitAfterReturn: NonNullable<ToolContext["emitEvent"]> | undefined
    const asyncEvents: SDKMessage[] = []
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        {
          content: [{ type: "tool_use", id: "background-1", name: "Background", input: {} }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "text", text: "background command accepted" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [{
        name: "Background",
        description: "starts background work",
        inputSchema: { type: "object", properties: {} },
        async call(_input, context) {
          emitAfterReturn = context.emitEvent
          context.emitEvent?.({
            type: "system",
            subtype: "task_started",
            task_id: "task_1",
            description: "background work",
            session_id: "session"
          })
          return { type: "tool_result" as const, tool_use_id: "", content: "started" }
        }
      }],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      onAsyncEvent: (event) => asyncEvents.push(event)
    })

    const events = await collectEvents(engine)
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "task_started",
      task_id: "task_1"
    }))

    emitAfterReturn?.({
      type: "system",
      subtype: "local_command_output",
      content: "late progress",
      session_id: "session"
    })
    emitAfterReturn?.({
      type: "system",
      subtype: "task_notification",
      task_id: "task_1",
      status: "completed",
      session_id: "session"
    })

    expect(asyncEvents).toEqual([
      expect.objectContaining({
        type: "system",
        subtype: "task_notification",
        task_id: "task_1",
        status: "completed"
      })
    ])
  })

  test("injects delayed LSP diagnostics into the next model request without starting a hidden turn", async () => {
    const provider = new StaticProvider([
      {
        content: [
          { type: "tool_use", id: "edit-1", name: "Edit", input: {} },
          { type: "tool_use", id: "write-1", name: "Write", input: {} },
        ],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        content: [{ type: "text", text: "fixed after diagnostics" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ])
    const asyncEvents: SDKMessage[] = []
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [
        {
          name: "Edit",
          description: "edit",
          inputSchema: { type: "object", properties: {} },
          async call(_input, context) {
            setTimeout(() => {
              context.emitEvent?.({
                type: "system",
                subtype: "lsp_diagnostics",
                session_id: "session",
                tool_use_id: "edit-1",
                file_path: "src/example.ts",
                mutation_version: 1,
                sha256: "abc",
                delayed: true,
                diagnostics: {
                  servers: ["typescript-language-server"],
                  total: 1,
                  errors: 1,
                  warnings: 0,
                  truncated: false,
                  items: [{
                    severity: 1,
                    message: "Cannot find name 'missing'.",
                    range: {
                      start: { line: 2, character: 4 },
                      end: { line: 2, character: 11 },
                    },
                  }],
                },
              })
            }, 0)
            return { type: "tool_result" as const, tool_use_id: "", content: "edited" }
          },
        },
        {
          name: "Write",
          description: "write",
          inputSchema: { type: "object", properties: {} },
          async call() {
            await wait(20)
            return { type: "tool_result" as const, tool_use_id: "", content: "written" }
          },
        },
      ],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      onAsyncEvent: (event) => asyncEvents.push(event),
    })

    await collectEvents(engine)

    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "runtime",
      content: expect.stringContaining("<internal_context type=\"lsp_diagnostics\">"),
    }))
    expect(provider.requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "runtime",
      content: expect.stringContaining("Cannot find name 'missing'."),
    }))
    expect(asyncEvents).toHaveLength(1)
  })

  test("treats a natural completion on the final allowed turn as success", async () => {
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([{
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }]),
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false,
      num_turns: 1
    })
  })

  test("completion guard feeds back into the loop before natural completion", async () => {
    let guardCalls = 0
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        {
          content: [{ type: "text", text: "initial answer" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "text", text: "completed after guard" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      completionGuard: async () => {
        guardCalls += 1
        return guardCalls === 1 ? "A task is still awaiting review. Resolve it before finishing." : undefined
      }
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "success",
      is_error: false,
      num_turns: 2
    })
    expect(guardCalls).toBe(2)
    expect(engine.getMessages()).toContainEqual(expect.objectContaining({
      role: "user",
      content: "A task is still awaiting review. Resolve it before finishing."
    }))
  })

  test("completion guard can stop with an error instead of reporting success", async () => {
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([{
        content: [{ type: "text", text: "verification failed" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }]),
      tools: [],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      completionGuard: async () => ({
        type: "stop",
        errorCode: "verification_failed_after_repair",
        message: "verification failed after one repair"
      })
    })

    await expect(collectResult(engine)).resolves.toMatchObject({
      subtype: "error_completion_guard",
      is_error: true,
      errors: ["verification failed after one repair"]
    })
  })

  test("preserves provider tool-call result order across concurrent and serial tools", async () => {
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        {
          content: [
            { type: "tool_use", id: "serial-1", name: "Serial", input: {} },
            { type: "tool_use", id: "concurrent-1", name: "Concurrent", input: {} }
          ],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 }
        },
        {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      ]),
      tools: [
        {
          name: "Serial",
          description: "serial tool",
          inputSchema: { type: "object", properties: {} },
          async call() {
            return { type: "tool_result" as const, tool_use_id: "", content: "serial result" }
          }
        },
        {
          name: "Concurrent",
          description: "concurrent tool",
          inputSchema: { type: "object", properties: {} },
          isConcurrencySafe: () => true,
          async call() {
            return { type: "tool_result" as const, tool_use_id: "", content: "concurrent result" }
          }
        }
      ],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    })

    await collectResult(engine)

    const toolResultMessage = engine.getMessages().find((message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.every((block: any) => block.type === "tool_result")
    )
    expect(toolResultMessage?.content).toEqual([
      expect.objectContaining({ tool_use_id: "serial-1", content: "serial result" }),
      expect.objectContaining({ tool_use_id: "concurrent-1", content: "concurrent result" })
    ])
  })

  // #210: NaN made every concurrent batch empty (all tools "did not return a
  // result"); '0' made the batch loop spin forever.
  for (const badValue of ["0", "garbage"]) {
    test(`invalid AGENT_SDK_MAX_TOOL_CONCURRENCY=${badValue} degrades to serial instead of failing or hanging`, async () => {
      const previous = process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY
      process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY = badValue
      try {
        const engine = new QueryEngine({
          cwd: process.cwd(),
          model: "test-model",
          provider: new StaticProvider([
            {
              content: [{ type: "tool_use", id: "concurrent-1", name: "Concurrent", input: {} }],
              stopReason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 }
            },
            {
              content: [{ type: "text", text: "done" }],
              stopReason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 }
            }
          ]),
          tools: [
            {
              name: "Concurrent",
              description: "concurrent tool",
              inputSchema: { type: "object", properties: {} },
              isConcurrencySafe: () => true,
              async call() {
                return { type: "tool_result" as const, tool_use_id: "", content: "concurrent result" }
              }
            }
          ],
          systemPrompt: "test",
          maxTurns: 2,
          maxTokens: 256,
          includePartialMessages: false,
          canUseTool: async () => ({ behavior: "allow" })
        })

        await collectResult(engine)

        const toolResultMessage = engine.getMessages().find((message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.every((block: any) => block.type === "tool_result")
        )
        expect(toolResultMessage?.content).toEqual([
          expect.objectContaining({ tool_use_id: "concurrent-1", content: "concurrent result" })
        ])
      } finally {
        if (previous === undefined) delete process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY
        else process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY = previous
      }
    })
  }
})

describe("QueryEngine context controller", () => {
  test("emits compaction started before awaiting compaction completion", async () => {
    const releaseCompaction = deferred<void>();
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => true,
        async compactConversation() {
          await releaseCompaction.promise;
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\ndelayed summary" },
              { role: "assistant", content: "I will continue." }
            ],
            summary: "delayed summary",
            metadata: {
              policy: "kernel-v1",
              source: "agent-runtime-kernel"
            }
          };
        }
      }
    });

    const iterator = engine.submitMessage("run");
    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "session_state_changed"
    });
    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "init"
    });

    const started = await Promise.race([iterator.next(), wait(30)]);
    if (started === null) {
      releaseCompaction.resolve();
    }

    expect(started).not.toBeNull();
    expect(started && "value" in started ? started.value : undefined).toMatchObject({
      type: "system",
      subtype: "context_compaction_started",
      compact_metadata: expect.objectContaining({
        trigger: "auto"
      })
    });

    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "context_compaction_progress",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        stage: "summarizing",
        progress: expect.any(Number)
      })
    });

    releaseCompaction.resolve();
    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "context_compaction_progress",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        stage: "rewriting_context",
        progress: expect.any(Number)
      })
    });

    expect((await iterator.next()).value).toMatchObject({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        summary: "delayed summary"
      })
    });
  });

  test("lets a host controller own auto-compaction decisions and metadata", async () => {
    const observedMessages: CreateMessageParams["messages"][] = [];
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedMessages.push(params.messages);
      return originalCreateMessage(params);
    };
    const boundaries: unknown[] = [];

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: ({ messages }) => messages.length > 0,
        getCompactionMetadata: () => ({
          policy: "kernel-v1",
          source: "agent-runtime-kernel",
          sourceMessageIds: ["user-1"]
        }),
        async compactConversation() {
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nkernel summary" },
              { role: "assistant", content: "I will continue." }
            ],
            summary: "kernel summary",
            metadata: {
              policy: "kernel-v1",
              source: "agent-runtime-kernel",
              sourceMessageIds: ["user-1"]
            }
          };
        },
        microCompactMessages: ({ messages }) => messages,
        onCompactionBoundary: (boundary) => {
          boundaries.push(boundary);
        }
      }
    });
    engine.messages.push({ role: "user", content: "old context" });

    const events = await collectEvents(engine);

    expect(observedMessages[0]?.[0]?.content).toContain("kernel summary");
    expect(boundaries).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_started",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        policy: "kernel-v1",
        source: "agent-runtime-kernel"
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        summary: "kernel summary",
        policy: "kernel-v1",
        source: "agent-runtime-kernel",
        source_message_ids: ["user-1"]
      })
    }));
  });

  test("preserves only the latest runtime context across compaction", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "stable system",
      runtimeContext: "latest runtime",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => true,
        async compactConversation() {
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nsummary" },
              { role: "runtime", content: "stale summarized runtime" }
            ],
            summary: "summary",
            metadata: { policy: "kernel-v1", source: "agent-runtime-kernel" }
          };
        }
      }
    });
    engine.messages.push({ role: "runtime", content: "old runtime" });

    await collectEvents(engine);

    const runtimeMessages = provider.requests[0]?.messages.filter((message) => message.role === "runtime");
    expect(runtimeMessages).toEqual([{ role: "runtime", content: "latest runtime" }]);
  });

  test("runs slash compact as a manual kernel compaction without calling the provider", async () => {
    const provider = new StaticProvider([]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => false,
        async compactConversation({ trigger }) {
          expect(trigger).toBe("manual");
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nmanual summary" },
              { role: "assistant", content: "I will continue." }
            ],
            summary: "manual summary",
            metadata: {
              policy: "kernel-v1",
              source: "agent-runtime-kernel"
            }
          };
        }
      }
    });
    engine.messages.push({ role: "user", content: "old context" });

    const events = await collectEvents(engine, "/compact");

    expect(engine.getMessages()[0]?.content).toContain("manual summary");
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        trigger: "manual",
        summary: "manual summary"
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "result",
      subtype: "success",
      num_turns: 0,
      is_error: false
    }));
  });

  test("emits prompt-too-long compaction boundary before retrying provider", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      async createMessage() {
        calls += 1;
        if (calls === 1) {
          const error = new Error("prompt is too long") as Error & { status: number };
          error.status = 400;
          throw error;
        }
        return {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        };
      }
    };
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => false,
        getCompactionMetadata: () => ({
          policy: "kernel-v1",
          source: "agent-runtime-kernel"
        }),
        async compactConversation({ trigger }) {
          expect(trigger).toBe("prompt_too_long");
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nretry summary" },
              { role: "assistant", content: "I will continue." }
            ],
            summary: "retry summary",
            metadata: {
              policy: "kernel-v1",
              source: "agent-runtime-kernel"
            }
          };
        }
      }
    });

    const events = await collectEvents(engine);

    expect(calls).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_started",
      compact_metadata: expect.objectContaining({
        trigger: "prompt_too_long",
        policy: "kernel-v1",
        source: "agent-runtime-kernel"
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        trigger: "prompt_too_long",
        summary: "retry summary"
      })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "result",
      subtype: "success",
      is_error: false
    }));
  });

  test("keeps the original history when compaction is rejected", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => true,
        async compactConversation({ messages, state }) {
          return {
            compacted: false,
            compactedMessages: messages,
            summary: "",
            failureReason: "max_tokens",
            state: { ...state, consecutiveFailures: state.consecutiveFailures + 1 }
          };
        }
      }
    });
    engine.messages.push({ role: "user", content: "original history" });

    const events = await collectEvents(engine);

    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("original history");
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: expect.objectContaining({
        outcome: "failed",
        failure_reason: "max_tokens"
      })
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_progress",
      compact_metadata: expect.objectContaining({ stage: "rewriting_context" })
    }));
  });

  test("checks automatic compaction only once before a tool loop", async () => {
    let checks = 0;
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "read-1", name: "Read", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 1 }
      }
    ]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [{
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        isReadOnly: () => true,
        async call() {
          return { type: "tool_result", tool_use_id: "read-1", content: "result" };
        }
      }],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => {
          checks += 1;
          return false;
        }
      }
    });

    await collectEvents(engine);

    expect(checks).toBe(1);
    expect(provider.requests).toHaveLength(2);
  });

  test("does not retry a prompt-too-long request when compaction is rejected", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      async createMessage() {
        calls += 1;
        const error = new Error("prompt is too long") as Error & { status: number };
        error.status = 400;
        throw error;
      }
    };
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      contextController: {
        shouldAutoCompact: () => false,
        async compactConversation({ messages }) {
          return {
            compacted: false,
            compactedMessages: messages,
            summary: "",
            failureReason: "max_tokens"
          };
        }
      }
    });

    const events = await collectEvents(engine, "current task");

    expect(calls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "result",
      subtype: "error_during_execution",
      is_error: true
    }));
  });
});

describe("QueryEngine auto compaction usage", () => {
  test("uses provider context usage threshold and records compaction usage outside the context anchor", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "text", text: structuredCompactionSummary }],
        stopReason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 8 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 10 }
      }
    ]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 16_384,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      sessionId: "thread-compact"
    });
    engine.messages.push({ role: "user", content: "o".repeat(80_000) });
    engine.messages.push({
      role: "assistant",
      content: "",
      usage: {
        inputTokens: 190_600,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 190_620
      },
      usageIdentity: {
        threadId: "thread-compact",
        callerKind: "conversation",
        turn: 1
      }
    } as any);
    engine.messages.push({ role: "user", content: "r".repeat(84_000) });

    const events = await collectEvents(engine);
    const result = events.find((event) => (event as { type?: string }).type === "result") as any;

    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_started",
      compact_metadata: expect.objectContaining({
        trigger: "auto",
        pre_tokens: expect.any(Number),
        context_window: 200_000
      })
    }));
    expect(result.billingUsage.records.map((record: any) => record.usageIdentity.callerKind)).toEqual([
      "compaction",
      "conversation"
    ]);
    expect(result.billingUsage.records[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 8
    });
    expect(result.contextUsage).toMatchObject({
      source: "provider",
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60
    });
  });

  test("does not auto compact when only non-conversation usage is above threshold", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 10 }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 16_384,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      sessionId: "thread-non-conversation"
    });
    engine.messages.push({
      role: "assistant",
      content: "",
      usage: normalizeProviderUsage({ input_tokens: 300_000, output_tokens: 1_000 }),
      usageIdentity: {
        threadId: "thread-non-conversation",
        callerKind: "compaction"
      }
    } as any);

    const events = await collectEvents(engine);

    expect(events).not.toContainEqual(expect.objectContaining({
      type: "system",
      subtype: "context_compaction_started"
    }));
  });
});

describe("QueryEngine skill allowed tools", () => {
  test("activates a matching deferred tool after loading a skill", async () => {
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "browser:browser" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, activatedTools: ["mcp__node_repl__js"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const browserTool = {
      name: "mcp__node_repl__js",
      description: "browser runtime",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "browser" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool],
      deferredTools: [browserTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(observedTools[0]).toEqual(["Read", "Skill"]);
    expect(observedTools[1]).toEqual(["Read", "Skill", "mcp__node_repl__js"]);
  });

  test("skill activation reports promoted names through onToolsActivated", async () => {
    const activations: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "browser:browser" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, activatedTools: ["mcp__node_repl__js"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const browserTool = {
      name: "mcp__node_repl__js",
      description: "browser runtime",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "browser" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool],
      deferredTools: [browserTool],
      onToolsActivated: (names) => activations.push([...names]),
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(activations).toEqual([["mcp__node_repl__js"]]);
  });

  test("skill narrowing without activation does not call onToolsActivated", async () => {
    const activations: string[][] = [];
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["Read"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const writeTool = {
      name: "Write",
      description: "write",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "write" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool, writeTool],
      onToolsActivated: (names) => activations.push([...names]),
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(activations).toEqual([]);
    expect(observedTools[0]).toEqual(["Read", "Skill", "Write"]);
    expect(observedTools[1]).toEqual(["Read", "Skill"]);
  });

  test("preserves runtime-required tools when Skill.allowedTools narrows visibility", async () => {
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["Read"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const taskReportTool = {
      name: "TaskReport",
      description: "report",
      inputSchema: { type: "object" as const, properties: {} },
      runtimeMetadata: { requiredDuringSkillScope: true },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "reported" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool, taskReportTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(observedTools[0]).toEqual(["Read", "Skill", "TaskReport"]);
    expect(observedTools[1]).toEqual(["Read", "Skill", "TaskReport"]);
  });

  test("applies Skill.allowedTools to subsequent provider turns in the same run", async () => {
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["Read"] })
        };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const writeTool = {
      name: "Write",
      description: "write",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "write" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, readTool, writeTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(observedTools[0]).toEqual(["Read", "Skill", "Write"]);
    expect(observedTools[1]).toEqual(["Read", "Skill"]);
  });

  test("applies Alice-style Skill.allowedTools aliases to SDK tool names", async () => {
    const observedTools: string[][] = [];
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["read_file", "bash"] })
        };
      }
    };
    const bashTool = {
      name: "Bash",
      description: "bash",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "bash" };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const writeTool = {
      name: "Write",
      description: "write",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "write" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, bashTool, readTool, writeTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(observedTools[0]).toEqual(["Bash", "Read", "Skill", "Write"]);
    expect(observedTools[1]).toEqual(["Bash", "Read", "Skill"]);
  });

  test("does not execute sibling tool calls in the same turn as a Skill activation", async () => {
    const observedTools: string[][] = [];
    const calledTools: string[] = [];
    const provider = new StaticProvider([
      {
        content: [
          { type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "demo" } },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "secret.txt" } },
          { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "secret.txt", content: "leak" } }
        ],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const originalCreateMessage = provider.createMessage.bind(provider);
    provider.createMessage = async (params) => {
      observedTools.push((params.tools ?? []).map((tool) => tool.name).sort());
      return originalCreateMessage(params);
    };
    const skillTool = {
      name: "Skill",
      description: "load skill",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        calledTools.push("Skill");
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ success: true, allowedTools: ["Bash"] })
        };
      }
    };
    const bashTool = {
      name: "Bash",
      description: "bash",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        calledTools.push("Bash");
        return { type: "tool_result" as const, tool_use_id: "", content: "bash" };
      }
    };
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      isReadOnly: () => true,
      async call() {
        calledTools.push("Read");
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const writeTool = {
      name: "Write",
      description: "write",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        calledTools.push("Write");
        return { type: "tool_result" as const, tool_use_id: "", content: "write" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [skillTool, bashTool, readTool, writeTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(calledTools).toEqual(["Skill"]);
    expect(observedTools[0]).toEqual(["Bash", "Read", "Skill", "Write"]);
    expect(observedTools[1]).toEqual(["Bash", "Skill"]);
  });
});

describe("QueryEngine deferred tool promotion", () => {
  test("activateTools promotes deferred tools into the native tools array", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "probe-1", name: "ProbeTool", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    let promoted: string[] = [];
    const probeTool = {
      name: "ProbeTool",
      description: "probe",
      inputSchema: { type: "object" as const, properties: {} },
      async call(_input: unknown, context: ToolContext) {
        promoted = context.activateTools?.(["GuanlanSearch", "GuanlanSearch", "NoSuchTool"]) ?? [];
        return { type: "tool_result" as const, tool_use_id: "", content: "probe done" };
      }
    };
    const deferredTool = {
      name: "GuanlanSearch",
      description: "search guanlan",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "guanlan" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [probeTool],
      deferredTools: [deferredTool],
      systemPrompt: "test",
      maxTurns: 5,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    // Unknown names are ignored and already-promoted names are not duplicated.
    expect(promoted).toEqual(["GuanlanSearch"]);
    const lastRequest = provider.requests[provider.requests.length - 1];
    const names = (lastRequest.tools ?? []).map((tool) => tool.name);
    expect(names).toContain("GuanlanSearch");
    expect(names.filter((name) => name === "GuanlanSearch")).toHaveLength(1);
  });

  test("activateTools reports promoted names through onToolsActivated", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "probe-1", name: "ProbeTool", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    const activations: string[][] = [];
    const probeTool = {
      name: "ProbeTool",
      description: "probe",
      inputSchema: { type: "object" as const, properties: {} },
      async call(_input: unknown, context: ToolContext) {
        context.activateTools?.(["GuanlanSearch", "NoSuchTool"]);
        // Second call promotes nothing: no callback, no duplicate report.
        context.activateTools?.(["GuanlanSearch"]);
        return { type: "tool_result" as const, tool_use_id: "", content: "probe done" };
      }
    };
    const deferredTool = {
      name: "GuanlanSearch",
      description: "search guanlan",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "guanlan" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [probeTool],
      deferredTools: [deferredTool],
      onToolsActivated: (names) => activations.push([...names]),
      systemPrompt: "test",
      maxTurns: 5,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(activations).toEqual([["GuanlanSearch"]]);
  });

  test("listAvailableTools returns native plus deferred tools live", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "probe-1", name: "ProbeTool", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    let before: string[] = [];
    let after: string[] = [];
    const probeTool = {
      name: "ProbeTool",
      description: "probe",
      inputSchema: { type: "object" as const, properties: {} },
      async call(_input: unknown, context: ToolContext) {
        before = (context.listAvailableTools?.() ?? []).map((tool) => tool.name);
        context.activateTools?.(["GuanlanSearch"]);
        after = (context.listAvailableTools?.() ?? []).map((tool) => tool.name);
        return { type: "tool_result" as const, tool_use_id: "", content: "probe done" };
      }
    };
    const nativeTool = {
      name: "NativeTool",
      description: "native",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "native" };
      }
    };
    const deferredTool = {
      name: "GuanlanSearch",
      description: "search guanlan",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "guanlan" };
      }
    };

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [probeTool, nativeTool],
      deferredTools: [deferredTool],
      systemPrompt: "test",
      maxTurns: 5,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(before).toEqual(["ProbeTool", "NativeTool", "GuanlanSearch"]);
    // After promotion the deferred tool is native, so the live catalog still lists it exactly once.
    expect(after).toEqual(["ProbeTool", "NativeTool", "GuanlanSearch"]);
  });

  test("ToolSearch end to end: constructor rebinding, native promotion, and deferred removal", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "search-1", name: "ToolSearch", input: { query: "select:GuanlanSearch" } }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "tool_use", id: "guanlan-1", name: "GuanlanSearch", input: {} }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ]);
    let guanlanCalls = 0;
    const deferredTool = {
      name: "GuanlanSearch",
      description: "search guanlan",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        guanlanCalls += 1;
        return { type: "tool_result" as const, tool_use_id: "", content: "guanlan result" };
      }
    };

    // Real factory output bound to an empty pool: only the engine's
    // construction-time rebinding can see the deferred tools.
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [createToolSearchTool(() => [])],
      deferredTools: [deferredTool],
      systemPrompt: "test",
      maxTurns: 5,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    await collectResult(engine);

    expect(provider.requests).toHaveLength(3);
    // Turn 1 result carries the direct-call guidance from the rebound ToolSearch.
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("call them directly by name");
    // Turn 2 request exposes the promoted tool natively, exactly once.
    const turnTwoNames = (provider.requests[1]?.tools ?? []).map((tool) => tool.name);
    expect(turnTwoNames).toContain("GuanlanSearch");
    expect(turnTwoNames.filter((name) => name === "GuanlanSearch")).toHaveLength(1);
    // The promoted tool executed natively and its result reached the final turn.
    expect(guanlanCalls).toBe(1);
    expect(JSON.stringify(provider.requests[2]?.messages)).toContain("guanlan result");
    // Promotion removed the tool from the deferred pool.
    const deferredNames = ((engine as any).config.deferredTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(deferredNames).not.toContain("GuanlanSearch");
  });
});

describe("QueryEngine usage records", () => {
  test("emits assistant usage and final billing/context usage contract", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 30
      }
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "gpt-4o-mini",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      sessionId: "thread-usage"
    });

    const events = await collectEvents(engine);
    const assistant = events.find((event) => (event as { type?: string }).type === "assistant") as any;
    const result = events.find((event) => (event as { type?: string }).type === "result") as any;

    expect(assistant.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 0,
      totalTokens: 150
    });
    expect(assistant.usageIdentity).toMatchObject({
      threadId: "thread-usage",
      callerKind: "conversation",
      turn: 1
    });
    expect(result.billingUsage.cumulative).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 0,
      totalTokens: 150
    });
    expect(result.billingUsage.latestRecord).toMatchObject({
      outputTokens: 20,
      usageIdentity: expect.objectContaining({ callerKind: "conversation" })
    });
    expect(result.contextUsage).toMatchObject({
      source: "provider",
      totalTokens: 150,
      contextWindow: 128_000
    });
  });

  test("includes per-provider-call usage records in the final result", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }],
        stopReason: "tool_use",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10
        }
      },
      {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: {
          input_tokens: 60,
          output_tokens: 15,
          cache_read_input_tokens: 5
        }
      }
    ]);
    const readTool = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object" as const, properties: {} },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "read" };
      }
    };
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "gpt-4o-mini",
      provider,
      tools: [readTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" })
    });

    const events = await collectEvents(engine);
    const result = events.find((event) => (event as { type?: string }).type === "result") as any;

    expect(result.usageRecords).toEqual([
      expect.objectContaining({
        callerLabel: "Turn 1",
        model: "gpt-4o-mini",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        turn: 1
      }),
      expect.objectContaining({
        callerLabel: "Turn 2",
        model: "gpt-4o-mini",
        inputTokens: 60,
        outputTokens: 15,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
        turn: 2
      })
    ]);
  });
});

describe("QueryEngine structured tool results", () => {
  test("keeps array tool results instead of JSON stringifying them", async () => {
    const structuredTool = {
      name: "js",
      description: "structured",
      inputSchema: { type: "object" as const, properties: {} },
      isEnabled: () => true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call() {
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: [
            { type: "text", text: "ready" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
          ],
          _meta: {
            traceId: "t-1",
            computerUseAction: {
              actionId: "action-1",
              action: "click",
              phase: "observed",
              window: { id: 42, app: "微信" },
            },
          },
        };
      },
    };
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider: new StaticProvider([
        {
          content: [{ type: "tool_use", id: "tool-1", name: "js", input: {} }],
          stopReason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        {
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ]),
      tools: [structuredTool],
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
    });

    const events = await collectEvents(engine);

    const toolResultMessage = engine.getMessages().find((msg) =>
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      msg.content.some((block: any) => block.type === "tool_result"),
    );

    expect(toolResultMessage).toBeDefined();
    expect((toolResultMessage!.content as any[])[0].content).toEqual([
      { type: "text", text: "ready" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
    ]);
    expect((toolResultMessage!.content as any[])[0]._meta).toMatchObject({ traceId: "t-1" });
    expect((engine as any).provider.requests[1].system).toBe("test");
    expect((engine as any).provider.requests[1].messages).toContainEqual(expect.objectContaining({
      role: "runtime",
      content: expect.stringContaining("action-1: click on 微信#42; phase=observed; not verified complete"),
    }));
    const streamedToolResult = events.find((event: any) => event.type === "tool_result") as any;
    expect(streamedToolResult.result.output).not.toContain("ZmFrZQ==");
    expect(streamedToolResult.result.output).toContain("[Image: image/png]");
  });

  test("strips internal image metadata before provider calls", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }]);
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
    });
    (engine as any).messages.push({
      role: "user",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "old" },
        _meta: { persist: false },
      }],
    });
    (engine as any).messages.push({
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "desktop-context",
        name: "current_context",
        input: {},
        _meta: { traceId: "tool-use" },
      }],
    });
    (engine as any).messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "desktop-context",
        content: [{
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "nested" },
          _meta: { persist: false },
        }],
        _meta: { traceId: "tool-result" },
      }],
    });

    await collectEvents(engine, [
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" },
        _meta: { persist: false },
      },
    ] as any);

    expect(JSON.stringify((provider as any).requests?.[0]?.messages)).not.toContain("_meta");
  });
});

describe("QueryEngine skill catalog injection", () => {
  test("appends an available_skills runtime message on every model call", async () => {
    const registry = new SkillRegistry([{
      name: "commit",
      description: "Create a git commit",
      getPrompt: async () => [{ type: "text", text: "commit" }],
    }])
    const provider = new StaticProvider([
      { content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "commit" } }], stopReason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    ])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],          // Skill 工具不必真注册：目录注入独立于工具执行
      systemPrompt: "test",
      maxTurns: 2,
      maxTokens: 256,
      skillRegistry: registry,
    })

    await collectEvents(engine)

    expect(provider.requests).toHaveLength(2)
    for (const request of provider.requests) {
      const runtime = request.messages.filter((m: any) => m.role === "runtime")
      expect(runtime.length).toBeGreaterThanOrEqual(1)
      expect(runtime.at(-1)?.content).toContain("<available_skills>")
      expect(String(runtime.at(-1)?.content)).toContain("- commit: Create a git commit")
    }
  })

  test("injects no catalog message when the registry is empty", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [],
      systemPrompt: "test",
      maxTurns: 1,
      maxTokens: 256,
      skillRegistry: new SkillRegistry(),
    })

    await collectEvents(engine)

    const runtimeMessages = provider.requests[0].messages.filter((m: any) => m.role === "runtime")
    expect(runtimeMessages.some((m: any) => String(m.content).includes("<available_skills>"))).toBe(false)
  })
});
