import { afterEach, describe, expect, test } from "bun:test"
import { QueryEngine } from "../engine.js"
import { AgentTool, clearAgents, registerAgents } from "./agent-tool.js"
import type { LLMProvider, CreateMessageParams, CreateMessageResponse, NormalizedTool } from "../providers/types.js"
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
  afterEach(() => {
    clearAgents()
  })

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

  test("AgentTool applies custom agent disallowedTools after visible tool selection", async () => {
    const observedToolNames: string[][] = []
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
        observedToolNames.push((params.tools ?? []).map((tool: NormalizedTool) => tool.name).sort())
        return {
          content: [{ type: "text", text: "planned" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      }
    }
    registerAgents({
      "planner-test": {
        description: "test planner",
        prompt: "Plan without mutating files.",
        tools: ["Read", "Write", "Edit", "Bash"],
        disallowedTools: ["Write", "Edit"]
      }
    })

    const result = await AgentTool.call({
      prompt: "plan this",
      description: "plan",
      subagent_type: "planner-test",
      mode: "bypassPermissions"
    }, {
      cwd: process.cwd(),
      provider,
      model: "test-model",
      apiType: "anthropic-messages"
    })

    expect(result.is_error).toBeFalsy()
    expect(observedToolNames[0]).toContain("Read")
    expect(observedToolNames[0]).toContain("Bash")
    expect(observedToolNames[0]).not.toContain("Write")
    expect(observedToolNames[0]).not.toContain("Edit")
    expect(observedToolNames[0]).not.toContain("Agent")
  })
})
