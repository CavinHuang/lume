import { describe, expect, test } from "bun:test"
import { createAgent } from "./agent.js"
import type { ToolDefinition } from "./types.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {} },
    async call() {
      return { type: "tool_result", tool_use_id: "", content: "ok" }
    },
  }
}

class StaticProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const

  async createMessage(_params: CreateMessageParams): Promise<CreateMessageResponse> {
    return {
      content: [{ type: "text", text: "summary" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

describe("Agent runtime tool resolver", () => {
  test("applies resolveRuntimeTools after base tools are assembled", async () => {
    const agent = createAgent({
      persistSession: false,
      tools: [tool("Read"), tool("Write")],
      resolveRuntimeTools: (tools) => tools.filter((item) => item.name !== "Write"),
    })
    await agent.getInitializationResult()

    expect((agent as any).toolPool.map((item: ToolDefinition) => item.name)).toEqual(["Read"])

    await agent.close()
  })
})

describe("Agent compact command", () => {
  test("does not record /compact as a normal user message", async () => {
    const agent = createAgent({
      persistSession: false,
      tools: [],
      contextController: {
        shouldAutoCompact: () => false,
        async compactConversation() {
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nsummary" },
              { role: "assistant", content: "I will continue." },
            ],
            summary: "summary",
            metadata: {
              policy: "kernel-v1",
              source: "agent-runtime-kernel",
            },
          }
        },
      },
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = new StaticProvider()

    for await (const _event of agent.query("/compact")) {
      // drain query
    }

    expect(agent.getMessages().some((message) =>
      message.type === "user" && message.message.content === "/compact"
    )).toBe(false)
    await agent.close()
  })
})
