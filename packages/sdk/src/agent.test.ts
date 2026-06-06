import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgent } from "./agent.js"
import type { ToolDefinition } from "./types.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"
import { getSessionMessages, saveSession } from "./session.js"
import { clearSkills } from "./skills/registry.js"

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
  clearSkills()
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

describe("Agent skill slash commands", () => {
  test("preserves skill argument hints in initialization commands", async () => {
    const agent = createAgent({
      persistSession: false,
      skills: [{
        name: "code-review",
        description: "Review code changes",
        argumentHint: "path to review",
        async getPrompt() {
          return [{ type: "text", text: "review prompt" }]
        },
      }],
    })

    const init = await agent.getInitializationResult()

    expect(init.commands.find((command) => command.name === "/code-review")).toMatchObject({
      name: "/code-review",
      description: "Review code changes",
      argumentHint: "path to review",
    })
    await agent.close()
  })

  test("expands /skill manual invocations before the provider turn", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({
      persistSession: false,
      tools: [],
      skills: [{
        name: "code-review",
        description: "Review code changes",
        async getPrompt(args) {
          return [{ type: "text", text: `Review target: ${args}` }]
        },
      }],
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("/skill code-review src/index.ts")) {
      // drain query
    }

    expect(provider.requests[0]?.messages[0]?.content).toBe("Review target: src/index.ts")
    await agent.close()
  })

  test("expands $skill manual invocations before the provider turn", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({
      persistSession: false,
      tools: [],
      skills: [{
        name: "code-review",
        description: "Review code changes",
        async getPrompt(args) {
          return [{ type: "text", text: `Review target: ${args}` }]
        },
      }],
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("$code-review src/index.ts")) {
      // drain query
    }

    expect(provider.requests[0]?.messages[0]?.content).toBe("Review target: src/index.ts")
    await agent.close()
  })

  test("applies manual skill allowed tools from the first provider turn", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({
      persistSession: false,
      tools: [tool("Read"), tool("Write")],
      skills: [{
        name: "code-review",
        description: "Review code changes",
        allowedTools: ["read_file"],
        async getPrompt(args) {
          return [{ type: "text", text: `Review target: ${args}` }]
        },
      }],
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("/code-review src/index.ts")) {
      // drain query
    }

    expect(provider.requests[0]?.tools?.map((item) => item.name)).toEqual(["Read"])
    await agent.close()
  })

  test("asks for argumentHint when a manual skill invocation omits args", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({
      persistSession: false,
      tools: [],
      skills: [{
        name: "code-review",
        description: "Review code changes",
        argumentHint: "path to review",
        async getPrompt(args) {
          return [{ type: "text", text: `Review target: ${args}` }]
        },
      }],
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    const askEvents = []
    for await (const event of agent.query("/code-review")) {
      askEvents.push(event)
    }

    expect(provider.requests).toHaveLength(0)
    expect(askEvents).toContainEqual(expect.objectContaining({
      type: "assistant",
      message: {
        role: "assistant",
        content: [expect.objectContaining({
          type: "text",
          text: expect.stringContaining("path to review"),
        })],
      },
    }))

    for await (const _event of agent.query("src/index.ts")) {
      // drain query
    }

    expect(provider.requests[0]?.messages.at(-1)?.content).toBe("Review target: src/index.ts")
    await agent.close()
  })

  test("asks for argumentHint when a $skill invocation omits args", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({
      persistSession: false,
      tools: [],
      skills: [{
        name: "code-review",
        description: "Review code changes",
        argumentHint: "path to review",
        async getPrompt(args) {
          return [{ type: "text", text: `Review target: ${args}` }]
        },
      }],
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    const askEvents = []
    for await (const event of agent.query("$code-review")) {
      askEvents.push(event)
    }

    expect(provider.requests).toHaveLength(0)
    expect(askEvents).toContainEqual(expect.objectContaining({
      type: "assistant",
      message: {
        role: "assistant",
        content: [expect.objectContaining({
          type: "text",
          text: expect.stringContaining("path to review"),
        })],
      },
    }))

    for await (const _event of agent.query("src/index.ts")) {
      // drain query
    }

    expect(provider.requests[0]?.messages.at(-1)?.content).toBe("Review target: src/index.ts")
    await agent.close()
  })
})

describe("Agent session persistence", () => {
  test("resumes from compacted summary instead of pre-compaction transcript", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-compact-resume-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `compact-resume-${crypto.randomUUID()}`

    await saveSession(sessionId, [{ role: "user", content: "old long context" }], {
      cwd: tempDir,
      model: "test-model",
      sessionMessages: [{
        uuid: "old-user-1",
        role: "user",
        timestamp: new Date().toISOString(),
        content: "old long context",
      }],
      checkpoints: {},
    })

    const compactingAgent = createAgent({
      resume: sessionId,
      persistSession: true,
      tools: [],
      cwd: tempDir,
      contextController: {
        shouldAutoCompact: () => false,
        async compactConversation() {
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\ndurable compact summary" },
              { role: "assistant", content: "I will continue." },
            ],
            summary: "durable compact summary",
          }
        },
      },
    })
    await compactingAgent.getInitializationResult()

    for await (const _event of compactingAgent.query("/compact")) {
      // drain query
    }
    await compactingAgent.close()

    const resumedAgent = createAgent({
      resume: sessionId,
      persistSession: false,
      tools: [],
      cwd: tempDir,
    })
    await resumedAgent.getInitializationResult()
    const provider = new CapturingProvider()
    ;(resumedAgent as any).provider = provider

    for await (const _event of resumedAgent.query("next turn")) {
      // drain query
    }

    const requestPayload = JSON.stringify(provider.requests[0]?.messages)
    expect(requestPayload).toContain("durable compact summary")
    expect(requestPayload).not.toContain("old long context")
    await resumedAgent.close()
  })

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
