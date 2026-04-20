import { describe, expect, test } from "bun:test"
import { QueryEngine } from "../engine.js"
import { AgentTool } from "./agent-tool.js"
import type { LLMProvider, CreateMessageParams, CreateMessageResponse } from "../providers/types.js"
import type { ToolDefinition } from "../types.js"

class StaticProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const
  private readonly responses: CreateMessageResponse[]
  private index = 0

  constructor(responses: CreateMessageResponse[]) {
    this.responses = responses
  }

  async createMessage(_params: CreateMessageParams): Promise<CreateMessageResponse> {
    const response = this.responses[this.index]
    this.index += 1
    if (!response) {
      throw new Error("unexpected provider call")
    }
    return response
  }
}

describe("AgentTool parallel execution", () => {
  test("AgentTool 应声明为 concurrency-safe，与并行文案保持一致", () => {
    expect(AgentTool.isConcurrencySafe?.()).toBeTrue()
  })

  test("QueryEngine 执行工具时应把当前 tool_use_id 注入 ToolContext", async () => {
    const observedToolUseIds: string[] = []
    const provider = new StaticProvider([
      {
        content: [{
          type: "tool_use",
          id: "tool-run-1",
          name: "CaptureContext",
          input: { label: "capture" }
        }],
        stopReason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      {
        content: [{
          type: "text",
          text: "done"
        }],
        stopReason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    ])

    const captureContextTool: ToolDefinition = {
      name: "CaptureContext",
      description: "capture tool context",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string" }
        }
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      isEnabled: () => true,
      async prompt() {
        return "capture"
      },
      async call(_input, context) {
        observedToolUseIds.push(context.toolUseId ?? "missing")
        return {
          type: "tool_result",
          tool_use_id: "",
          content: "captured"
        }
      }
    }

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [captureContextTool],
      systemPrompt: "test",
      maxTurns: 4,
      maxTokens: 256,
      canUseTool: async () => ({ behavior: "allow" })
    })

    for await (const _event of engine.submitMessage("capture")) {
      // drain
    }

    expect(observedToolUseIds).toEqual(["tool-run-1"])
  })
})
