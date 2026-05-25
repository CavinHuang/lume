import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgent } from "./agent.js"
import type { ToolDefinition } from "./types.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"
import { getSessionMessages, saveSession } from "./session.js"

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

class ToolUseProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const

  async createMessage(_params: CreateMessageParams): Promise<CreateMessageResponse> {
    return {
      content: [{
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: {},
      }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

class CapturingProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const
  requests: CreateMessageParams[] = []

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.requests.push(params)
    return {
      content: [{ type: "text", text: "ok" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.OPEN_AGENT_SDK_HOME
})

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

describe("Agent session persistence", () => {
  test("restores nested assistant SDK messages as assistant content blocks", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-nested-assistant-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `nested-assistant-${crypto.randomUUID()}`
    const assistantBlocks = [{ type: "text", text: "请选择 1 基于初稿修改" }]

    await saveSession(sessionId, [], {
      cwd: tempDir,
      model: "test-model",
      sessionMessages: [{
        uuid: "assistant-1",
        role: "assistant",
        timestamp: new Date().toISOString(),
        content: {
          role: "assistant",
          content: assistantBlocks,
        },
      }],
      checkpoints: {},
    })

    const agent = createAgent({
      resume: sessionId,
      persistSession: false,
      tools: [],
      cwd: tempDir,
    })
    await agent.getInitializationResult()
    const provider = new CapturingProvider()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("1")) {
      // drain query
    }

    const restoredAssistant = provider.requests[0]?.messages.find((message) => message.role === "assistant")
    expect(Array.isArray(restoredAssistant?.content)).toBe(true)
    expect((restoredAssistant?.content as Array<{ type?: string; text?: string }> | undefined)?.some((block) =>
      block.type === "text" && block.text === "请选择 1 基于初稿修改"
    )).toBe(true)
    await agent.close()
  })

  test("persists session when query stream consumer stops after max turns", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-early-close-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `early-close-${crypto.randomUUID()}`
    const agent = createAgent({
      sessionId,
      persistSession: true,
      tools: [tool("Read")],
      cwd: tempDir,
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = new ToolUseProvider()

    for await (const event of agent.query("original task", { maxTurns: 1 })) {
      if (event.type === "result" && event.subtype === "error_max_turns") {
        break
      }
    }

    const messages = await getSessionMessages(sessionId, { dir: tempDir })
    expect(messages.some((message) =>
      message.role === "user" && JSON.stringify(message.content).includes("original task")
    )).toBe(true)
    await agent.close()
  })

  test("persists user message before provider request starts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-preflight-persist-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `preflight-persist-${crypto.randomUUID()}`
    let sawUserMessageBeforeProviderResponse = false
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      async createMessage() {
        const messages = await getSessionMessages(sessionId, { dir: tempDir })
        sawUserMessageBeforeProviderResponse = messages.some((message) =>
          message.role === "user" && JSON.stringify(message.content).includes("crash durable task")
        )
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
    }
    const agent = createAgent({
      sessionId,
      persistSession: true,
      tools: [],
      cwd: tempDir,
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("crash durable task")) {
      // drain query
    }

    expect(sawUserMessageBeforeProviderResponse).toBe(true)
    await agent.close()
  })
})
