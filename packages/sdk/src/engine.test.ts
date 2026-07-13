import { describe, expect, test } from "bun:test"
import { QueryEngine } from "./engine.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"
import { normalizeProviderUsage } from "./utils/usage.js"

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

describe("QueryEngine turn limits", () => {
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
});

describe("QueryEngine auto compaction usage", () => {
  test("uses provider context usage threshold and records compaction usage outside the context anchor", async () => {
    const provider = new StaticProvider([
      {
        content: [{ type: "text", text: "compact summary" }],
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
    engine.messages.push({
      role: "assistant",
      content: "",
      usage: {
        inputTokens: 170_600,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalTokens: 170_620
      },
      usageIdentity: {
        threadId: "thread-compact",
        callerKind: "conversation",
        turn: 1
      }
    } as any);

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
    expect((engine as any).provider.requests[1].system).toContain(
      "action-1: click on 微信#42; phase=observed; not verified complete",
    );
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
