import { describe, expect, test } from "bun:test"
import { QueryEngine } from "./engine.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"

class StaticProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const
  private index = 0

  constructor(private readonly responses: CreateMessageResponse[]) {}

  async createMessage(_params: CreateMessageParams): Promise<CreateMessageResponse> {
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
})

describe("QueryEngine context controller", () => {
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
});

describe("QueryEngine usage records", () => {
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
