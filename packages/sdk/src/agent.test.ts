import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgent } from "./agent.js"
import { SkillTool } from "./tools/skill-tool.js"
import type { ToolDefinition } from "./types.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"
import { forkSession, getSessionMessages, saveSession } from "./session.js"
import { clearSkills, getSkill } from "./skills/registry.js"

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
const originalLumeConfigDir = process.env.LUME_CONFIG_DIR
const originalAliceConfigDir = process.env.ALICE_CONFIG_DIR
const originalOpenAgentSdkHome = process.env.OPEN_AGENT_SDK_HOME

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (originalLumeConfigDir === undefined) {
    delete process.env.LUME_CONFIG_DIR
  } else {
    process.env.LUME_CONFIG_DIR = originalLumeConfigDir
  }
  if (originalAliceConfigDir === undefined) {
    delete process.env.ALICE_CONFIG_DIR
  } else {
    process.env.ALICE_CONFIG_DIR = originalAliceConfigDir
  }
  if (originalOpenAgentSdkHome === undefined) {
    delete process.env.OPEN_AGENT_SDK_HOME
  } else {
    process.env.OPEN_AGENT_SDK_HOME = originalOpenAgentSdkHome
  }
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

  test("binds an explicitly supplied Skill tool to the agent skill registry", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-agent-explicit-skill-tool-"))
    tempDirs.push(root)
    mkdirSync(join(root, "agent-wiki"), { recursive: true })
    writeFileSync(
      join(root, "agent-wiki", "SKILL.md"),
      "---\nname: Wiki\ndescription: Manage the wiki\n---\nIngest into wiki: ${ARG}",
      "utf-8",
    )

    const agent = createAgent({
      persistSession: false,
      tools: [SkillTool],
      skillsDirectories: [root],
    })
    await agent.getInitializationResult()

    const skillTool = (agent as any).toolPool.find((item: ToolDefinition) => item.name === "Skill") as ToolDefinition
    const result = await skillTool.call(
      { skill: "lume-workspace-demo:agent-wiki", args: "draft" },
      { cwd: root },
    )

    expect(result.is_error).toBeUndefined()
    expect(result.content).toContain("Ingest into wiki: draft")
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
  test("reloads added, updated, and deleted filesystem skills between turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-agent-hot-skill-"))
    tempDirs.push(root)
    const skillDir = join(root, "hot-skill")
    const skillFile = join(skillDir, "SKILL.md")
    const writeSkill = (body: string) => {
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(
        skillFile,
        `---\nname: Hot Skill\ndescription: Reload test\n---\n${body}`,
        "utf-8",
      )
    }

    const provider = new CapturingProvider()
    const agent = createAgent({
      persistSession: false,
      tools: [],
      skillsDirectories: [root],
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    expect(getSkill("hot-skill")).toBeUndefined()

    writeSkill("First prompt: ${ARG}")
    for await (const _event of agent.query("/skill hot-skill one")) {
      // drain query
    }
    expect(provider.requests[0]?.messages.at(-1)?.content).toBe("/skill hot-skill one")
    expect((agent as any).skillRegistry.get("hot-skill")?.invocationDescriptor.promptTemplate).toBe("First prompt: ${ARG}")

    writeSkill("Updated prompt: ${ARG}")
    for await (const _event of agent.query("/skill hot-skill two")) {
      // drain query
    }
    expect(provider.requests[1]?.messages.at(-1)?.content).toBe("/skill hot-skill two")
    expect((agent as any).skillRegistry.get("hot-skill")?.invocationDescriptor.promptTemplate).toBe("Updated prompt: ${ARG}")

    rmSync(skillDir, { recursive: true, force: true })
    for await (const _event of agent.query("refresh after deletion")) {
      // drain query
    }
    expect(getSkill("hot-skill")).toBeUndefined()
    expect((agent as any).skillRegistry.get("hot-skill")).toBeUndefined()

    await agent.close()
  })

  test("close unregisters filesystem skills owned by that agent", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "sdk-agent-file-skill-a-"))
    const rootB = mkdtempSync(join(tmpdir(), "sdk-agent-file-skill-b-"))
    tempDirs.push(rootA, rootB)
    mkdirSync(join(rootA, "leaky-skill"), { recursive: true })
    writeFileSync(
      join(rootA, "leaky-skill", "SKILL.md"),
      "---\nname: Leaky Skill\ndescription: first agent only\n---\nOnly A.",
      "utf-8",
    )

    const agentA = createAgent({
      persistSession: false,
      tools: [],
      skillsDirectories: [rootA],
    })
    expect((await agentA.getInitializationResult()).skills).toContain("leaky-skill")
    await agentA.close()

    const agentB = createAgent({
      persistSession: false,
      tools: [],
      skillsDirectories: [rootB],
    })
    expect((await agentB.getInitializationResult()).skills).not.toContain("leaky-skill")
    await agentB.close()
  })

  test("isolates same-slug skills across concurrent agents", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "sdk-agent-owner-a-"))
    const rootB = mkdtempSync(join(tmpdir(), "sdk-agent-owner-b-"))
    tempDirs.push(rootA, rootB)
    for (const [root, description] of [[rootA, "owner A"], [rootB, "owner B"]]) {
      mkdirSync(join(root, "shared-skill"), { recursive: true })
      writeFileSync(
        join(root, "shared-skill", "SKILL.md"),
        `---\nname: Shared Skill\ndescription: ${description}\n---\n${description}.`,
        "utf-8",
      )
    }

    const agentA = createAgent({ persistSession: false, tools: [], skillsDirectories: [rootA] })
    const agentB = createAgent({ persistSession: false, tools: [], skillsDirectories: [rootB] })
    await Promise.all([agentA.getInitializationResult(), agentB.getInitializationResult()])

    expect((agentA as any).skillRegistry.get("shared-skill")?.description).toBe("owner A")
    expect((agentB as any).skillRegistry.get("shared-skill")?.description).toBe("owner B")
    await agentA.close()
    expect((agentB as any).skillRegistry.get("shared-skill")?.description).toBe("owner B")
    await agentB.close()
  })

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

    expect(init.commands.find((command) => command.name === "/code-review")).toBeUndefined()
    await agent.close()
  })

  test("treats legacy /skill syntax as literal text", async () => {
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

    expect(provider.requests[0]?.messages[0]?.content).toBe("/skill code-review src/index.ts")
    await agent.close()
  })

  test("explicit skills override filesystem skills with the same name", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-explicit-skill-"))
    tempDirs.push(tempDir)
    process.env.LUME_CONFIG_DIR = join(tempDir, "lume")
    process.env.ALICE_CONFIG_DIR = join(tempDir, "alice")
    const fileSkillDir = join(process.env.ALICE_CONFIG_DIR, "skills", "code-review")
    mkdirSync(fileSkillDir, { recursive: true })
    writeFileSync(
      join(fileSkillDir, "SKILL.md"),
      [
        "---",
        'name: "文件代码审查"',
        'description: "Filesystem code review"',
        'when_to_use: "When reviewing code from disk"',
        "---",
        "",
        "Filesystem prompt."
      ].join("\n"),
      "utf-8"
    )

    const provider = new CapturingProvider()
    const agent = createAgent({
      cwd: tempDir,
      persistSession: false,
      tools: [],
      skills: [{
        name: "code-review",
        description: "Explicit code review",
        async getPrompt(args) {
          return [{ type: "text", text: `Explicit target: ${args}` }]
        },
      }],
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("/skill code-review src/index.ts")) {
      // drain query
    }

    expect(provider.requests[0]?.messages[0]?.content).toBe("/skill code-review src/index.ts")
    await agent.close()
  })

  test("treats legacy $skill syntax as literal text", async () => {
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

    expect(provider.requests[0]?.messages[0]?.content).toBe("$code-review src/index.ts")
    await agent.close()
  })

  test("does not apply skill tool restrictions from legacy slash text", async () => {
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

    expect(provider.requests[0]?.tools?.map((item) => item.name)).toEqual(["Read", "Write"])
    await agent.close()
  })

  test("does not request skill arguments from legacy slash text", async () => {
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

    expect(provider.requests[0]?.messages.at(-1)?.content).toBe("/code-review")

    for await (const _event of agent.query("src/index.ts")) {
      // drain query
    }

    expect(provider.requests[1]?.messages.at(-1)?.content).toBe("src/index.ts")
    await agent.close()
  })

  test("does not request skill arguments from legacy dollar text", async () => {
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

    expect(provider.requests[0]?.messages.at(-1)?.content).toBe("$code-review")

    for await (const _event of agent.query("src/index.ts")) {
      // drain query
    }

    expect(provider.requests[1]?.messages.at(-1)?.content).toBe("src/index.ts")
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

  test("resumes canonical tool results when event transcript omits them", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-tool-result-resume-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `tool-result-resume-${crypto.randomUUID()}`
    const toolUse = {
      type: "tool_use" as const,
      id: "call_001",
      response_item_id: "fc_001",
      name: "Read",
      input: {},
    }

    await saveSession(sessionId, [
      { role: "user", content: "read" },
      { role: "assistant", content: [toolUse] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_001", content: "file contents" }],
      },
    ], {
      cwd: tempDir,
      model: "test-model",
      sessionMessages: [
        {
          uuid: "user-1",
          role: "user",
          timestamp: new Date().toISOString(),
          content: "read",
        },
        {
          uuid: "assistant-1",
          role: "assistant",
          timestamp: new Date().toISOString(),
          content: { role: "assistant", content: [toolUse] },
        },
      ],
      checkpoints: {},
    })

    const agent = createAgent({ resume: sessionId, persistSession: false, tools: [], cwd: tempDir })
    await agent.getInitializationResult()
    const provider = new CapturingProvider()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("continue")) {
      // drain query
    }

    const requestBlocks = provider.requests[0]?.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : []
    )
    expect(requestBlocks).toContainEqual({
      type: "tool_result",
      tool_use_id: "call_001",
      content: "file contents",
    })
    await agent.close()
  })

  test("repairs legacy missing tool results from completed tool events", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-tool-result-repair-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `tool-result-repair-${crypto.randomUUID()}`
    const toolUse = {
      type: "tool_use" as const,
      id: "call_legacy",
      response_item_id: "fc_legacy",
      name: "Read",
      input: {},
    }

    await saveSession(sessionId, [
      { role: "user", content: "read" },
      { role: "assistant", content: [toolUse] },
    ], {
      cwd: tempDir,
      model: "test-model",
      sessionMessages: [
        {
          uuid: "user-1",
          role: "user",
          timestamp: new Date().toISOString(),
          content: "read",
        },
        {
          uuid: "assistant-1",
          role: "assistant",
          timestamp: new Date().toISOString(),
          content: { role: "assistant", content: [toolUse] },
        },
        {
          uuid: "tool-completed-1",
          role: "system",
          timestamp: new Date().toISOString(),
          content: {
            type: "system",
            subtype: "tool_completed",
            tool_use_id: "call_legacy",
            tool_name: "Read",
            output_summary: "legacy file contents",
            is_error: false,
          },
        },
      ],
      checkpoints: {},
    })

    const agent = createAgent({ resume: sessionId, persistSession: false, tools: [], cwd: tempDir })
    await agent.getInitializationResult()
    const provider = new CapturingProvider()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("continue")) {
      // drain query
    }

    const requestBlocks = provider.requests[0]?.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : []
    )
    expect(requestBlocks).toContainEqual({
      type: "tool_result",
      tool_use_id: "call_legacy",
      content: "legacy file contents",
      is_error: false,
    })
    await agent.close()
  })

  test("persists executed tool results in the resumable event transcript", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-tool-result-persist-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `tool-result-persist-${crypto.randomUUID()}`
    let requestCount = 0
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      async createMessage() {
        requestCount += 1
        return requestCount === 1
          ? {
              content: [{ type: "tool_use", id: "call_persist", name: "Read", input: {} }],
              stopReason: "tool_use",
              usage: { input_tokens: 1, output_tokens: 1 },
            }
          : {
              content: [{ type: "text", text: "done" }],
              stopReason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }
      },
    }
    const agent = createAgent({
      sessionId,
      persistSession: true,
      tools: [tool("Read")],
      cwd: tempDir,
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("read")) {
      // drain query
    }

    const messages = await getSessionMessages(sessionId, { dir: tempDir })
    expect(messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "call_persist",
        tool_name: "Read",
        content: "ok",
        is_error: false,
      }],
    }))
    await agent.close()
  })

  test("persists runtime context, replays it before the user, and hides it from normal history", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-runtime-context-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `runtime-context-${crypto.randomUUID()}`
    let capturedMessages: CreateMessageParams["messages"] = []
    const provider: LLMProvider = {
      apiType: "openai-completions",
      async createMessage(params) {
        capturedMessages = params.messages
        return {
          content: [{ type: "text", text: "done" }],
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
      runtimeContext: "current runtime",
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("hello")) {
      // drain query
    }

    expect(capturedMessages.slice(-2)).toEqual([
      { role: "runtime", content: "current runtime" },
      { role: "user", content: "hello" },
    ])
    expect((await getSessionMessages(sessionId, { dir: tempDir })).some((message) => message.role === "runtime")).toBe(false)
    expect((await getSessionMessages(sessionId, { dir: tempDir, includeSystemMessages: true }))).toContainEqual(
      expect.objectContaining({ role: "runtime", content: "current runtime" }),
    )
    await agent.close()

    const forkedSessionId = `runtime-context-fork-${crypto.randomUUID()}`
    await forkSession(sessionId, forkedSessionId)
    expect(await getSessionMessages(forkedSessionId, { dir: tempDir, includeSystemMessages: true })).toContainEqual(
      expect.objectContaining({ role: "runtime", content: "current runtime" }),
    )

    const resumedAgent = createAgent({
      sessionId,
      resume: sessionId,
      persistSession: true,
      tools: [],
      cwd: tempDir,
      runtimeContext: "next runtime",
    })
    await resumedAgent.getInitializationResult()
    ;(resumedAgent as any).provider = provider
    for await (const _event of resumedAgent.query("again")) {
      // drain resumed query
    }
    expect(capturedMessages.filter((message) => message.role === "runtime")).toEqual([
      { role: "runtime", content: "current runtime" },
      { role: "runtime", content: "next runtime" },
    ])
    expect(capturedMessages.slice(-2)).toEqual([
      { role: "runtime", content: "next runtime" },
      { role: "user", content: "again" },
    ])
    await resumedAgent.close()
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

  test("does not persist non-persistent tool result image payloads", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lume-sdk-image-redaction-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `image-redaction-${crypto.randomUUID()}`

    await saveSession(sessionId, [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool-image",
        content: [
          { type: "text", text: "{\"status\":\"ok\"}" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            _meta: { screenshotId: "shot-1", persist: false },
          },
        ],
      }],
    }], {
      cwd: tempDir,
      model: "test-model",
      sessionMessages: [{
        uuid: "tool-result-1",
        role: "user",
        timestamp: new Date().toISOString(),
        content: [{
          type: "tool_result",
          tool_use_id: "tool-image",
          content: [
            { type: "text", text: "{\"status\":\"ok\"}" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
              _meta: { screenshotId: "shot-1", persist: false },
            },
          ],
        }],
      }],
      checkpoints: {},
    })

    const persisted = JSON.stringify(await getSessionMessages(sessionId, { dir: tempDir }))
    expect(persisted).not.toContain("iVBORw0KGgo=")
    expect(persisted).toContain("shot-1")
    expect(persisted).toContain("image omitted from persisted transcript")
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
