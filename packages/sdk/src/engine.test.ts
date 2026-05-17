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
