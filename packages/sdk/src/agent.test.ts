import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgent, sessionMessagesFromHistory } from "./agent.js"
import { SkillTool } from "./tools/skill-tool.js"
import type { SDKMessage, ToolDefinition } from "./types.js"
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
const originalToolSearch = process.env.ENABLE_TOOL_SEARCH

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
  if (originalToolSearch === undefined) {
    delete process.env.ENABLE_TOOL_SEARCH
  } else {
    process.env.ENABLE_TOOL_SEARCH = originalToolSearch
  }
  clearSkills()
})

describe("Agent provider configuration", () => {
  test("prompt() rejects loudly when no provider is injected", async () => {
    const agent = createAgent({ persistSession: false, tools: [] })

    await expect(agent.prompt("hello")).rejects.toThrow("No LLMProvider configured")
    expect(agent.getMessages()).toHaveLength(0)
    await agent.close()
  })

  test("per-run provider overrides throw before the abort listener is attached", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({ persistSession: false, tools: [], provider })
    const controller = new AbortController()
    const signal = controller.signal
    let listenerAdds = 0
    const originalAdd = signal.addEventListener.bind(signal)
    ;(signal as any).addEventListener = (...args: unknown[]) => {
      listenerAdds += 1
      return (originalAdd as any)(...args)
    }

    await expect(
      (async () => {
        for await (const _event of agent.query("hello", {
          abortSignal: signal,
          apiKey: "sk-legacy",
        } as any)) {
          // drain
        }
      })(),
    ).rejects.toThrow("Per-run provider overrides are no longer supported")
    expect(listenerAdds).toBe(0)
    await agent.close()
  })

  test("auth_status is no longer emitted for host-injected provider runs", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({ persistSession: false, tools: [], provider })

    const events: SDKMessage[] = []
    for await (const event of agent.query("hello")) {
      events.push(event)
    }

    expect(events.find((event) => event.type === "auth_status")).toBeUndefined()
    await agent.close()
  })

  test("initialization account reflects provider injection, not apiKey fields", async () => {
    const bare = createAgent({ persistSession: false, tools: [] })
    const bareInit = await bare.getInitializationResult()
    expect(bareInit.account.apiKeySource).toBe("missing")
    expect(bareInit.account.tokenSource).toBe("missing")
    await bare.close()

    const provider = new CapturingProvider()
    const configured = createAgent({ persistSession: false, tools: [], provider })
    const configuredInit = await configured.getInitializationResult()
    expect(configuredInit.account.apiKeySource).toBe("configured")
    expect(configuredInit.account.tokenSource).toBe("configured")
    await configured.close()
  })
})

describe("Agent runtime tool resolver", () => {
  test("does not start a query when the parent signal is already aborted", async () => {
    const provider = new CapturingProvider()
    const controller = new AbortController()
    controller.abort(new Error("stopped"))
    const agent = createAgent({
      persistSession: false,
      tools: [],
      provider,
      model: "host/model-a",
    })

    const events: SDKMessage[] = []
    for await (const event of agent.query("hello", { abortSignal: controller.signal })) {
      events.push(event)
    }

    // Soft abort: the run resolves normally with an error result and no provider call.
    expect(provider.requests).toHaveLength(0)
    const result = events.find((event) => event.type === "result")
    expect(result?.subtype).toBe("error_during_execution")
    await agent.close()
  })

  test("keeps a host-provided provider when initialization and model changes refresh config", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({
      persistSession: false,
      tools: [],
      provider,
      model: "host/model-a",
    })

    await agent.getInitializationResult()
    expect((agent as any).provider).toBe(provider)

    await agent.setModel("host/model-b")
    expect((agent as any).provider).toBe(provider)

    await agent.close()
  })

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

  test("rebuildToolPool keeps core tools eager and defers the rest", async () => {
    const agent = createAgent({
      persistSession: false,
      tools: [tool("Bash"), tool("GuanlanSearch")],
      provider: new StaticProvider(),
      model: "host/model-a",
    })
    await agent.getInitializationResult()

    const toolPool = (agent as any).toolPool as ToolDefinition[]
    const deferredPool = (agent as any).deferredToolPool as ToolDefinition[]
    // Built-in core tools stay in the eager pool.
    expect(toolPool.map((t) => t.name)).toContain("Bash")
    // ToolSearch/ExecuteTool are injected into the eager pool when deferred is non-empty.
    expect(toolPool.map((t) => t.name)).toContain("ToolSearch")
    expect(toolPool.map((t) => t.name)).toContain("ExecuteTool")
    // Core tools never land in deferred; non-core tools do.
    expect(deferredPool.map((t) => t.name)).not.toContain("Bash")
    expect(deferredPool.map((t) => t.name)).toContain("GuanlanSearch")

    await agent.close()
  })

  test("rebuildToolPool shrinks the pools when resolveRuntimeTools drops a tool", async () => {
    process.env.ENABLE_TOOL_SEARCH = "tst"
    let resolveCount = 0
    const agent = createAgent({
      persistSession: false,
      tools: [tool("Read"), tool("DisposableExtra"), tool("SurvivingExtra")],
      resolveRuntimeTools: (tools) => {
        resolveCount += 1
        return resolveCount === 1 ? tools : tools.filter((item) => item.name !== "DisposableExtra")
      },
    })
    await agent.getInitializationResult()

    // First rebuild: Read stays core-eager, both extras defer, generated pair injected.
    expect((agent as any).toolPool.map((t: ToolDefinition) => t.name)).toEqual(["Read", "ToolSearch", "ExecuteTool"])
    expect((agent as any).deferredToolPool.map((t: ToolDefinition) => t.name)).toEqual(["DisposableExtra", "SurvivingExtra"])

    // Second rebuild without DisposableExtra: the previous registration is
    // disposed, so the dropped tool is gone from both pools while the
    // generated pair and the surviving deferred tool remain.
    await (agent as any).rebuildToolPool()
    expect((agent as any).toolPool.map((t: ToolDefinition) => t.name)).toEqual(["Read", "ToolSearch", "ExecuteTool"])
    expect((agent as any).deferredToolPool.map((t: ToolDefinition) => t.name)).toEqual(["SurvivingExtra"])

    await agent.close()
  })

  test("registers generated discovery tools with the host runtime", async () => {
    process.env.ENABLE_TOOL_SEARCH = "tst"
    const registered: string[] = []
    const agent = createAgent({
      persistSession: false,
      tools: [tool("Read"), tool("PrivateResearch")],
      registerGeneratedRuntimeTools: (tools) => {
        registered.push(...tools.map((item) => item.name))
      },
    })

    await agent.getInitializationResult()

    expect(registered).toEqual(["ToolSearch", "ExecuteTool"])
    await agent.close()
  })

  test("binds runtime tools to the resumed session identity", async () => {
    process.env.ENABLE_TOOL_SEARCH = "tst"
    const tempDir = mkdtempSync(join(tmpdir(), "sdk-agent-runtime-resume-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `runtime-resume-${crypto.randomUUID()}`
    await saveSession(sessionId, [], { cwd: tempDir, model: "test-model" })
    const resolvedSessionIds: string[] = []
    const registeredSessionIds: string[] = []
    const agent = createAgent({
      resume: sessionId,
      persistSession: false,
      cwd: tempDir,
      tools: [tool("Read"), tool("PrivateResearch")],
      resolveRuntimeTools: (tools, context) => {
        resolvedSessionIds.push(context.sessionId)
        return tools
      },
      registerGeneratedRuntimeTools: (_tools, context) => {
        registeredSessionIds.push(context.sessionId)
      },
    })

    await agent.getInitializationResult()

    expect(resolvedSessionIds).toEqual([sessionId])
    expect(registeredSessionIds).toEqual([sessionId])
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

  test("defers non-core schemas and executes selected tools through the normal permission path", async () => {
    process.env.ENABLE_TOOL_SEARCH = "tst"
    let targetCalls = 0
    const target: ToolDefinition = {
      ...tool("CustomResearch"),
      description: "Search a private research index.",
      async call() {
        targetCalls += 1
        return { type: "tool_result", tool_use_id: "", content: "research result" }
      },
    }
    const provider = new class implements LLMProvider {
      readonly apiType = "anthropic-messages" as const
      requests: CreateMessageParams[] = []
      async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
        this.requests.push(params)
        const turn = this.requests.length
        if (turn === 1) {
          return { content: [{ type: "tool_use", id: "search-1", name: "ToolSearch", input: { query: "research" } }], stopReason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }
        }
        if (turn === 2) {
          return { content: [{ type: "tool_use", id: "execute-1", name: "ExecuteTool", input: { tool_name: "CustomResearch", params: {} } }], stopReason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      }
    }()
    const permissionNames: string[] = []
    const agent = createAgent({
      persistSession: false,
      tools: [tool("Read"), target],
      canUseTool: async (selected) => {
        permissionNames.push(selected.name)
        return { behavior: "allow" }
      },
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("find research")) {
      // drain query
    }

    expect(provider.requests[0]?.tools.map((item) => item.name)).toEqual(["Read", "ToolSearch", "ExecuteTool"])
    expect(targetCalls).toBe(1)
    expect(permissionNames).toContain("CustomResearch")
    expect(permissionNames).not.toContain("ExecuteTool")
    await agent.close()
  })

  test("persists tool promotions across queries for the agent lifetime", async () => {
    process.env.ENABLE_TOOL_SEARCH = "tst"
    const provider = new class implements LLMProvider {
      readonly apiType = "anthropic-messages" as const
      requests: CreateMessageParams[] = []
      async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
        this.requests.push(params)
        if (this.requests.length === 1) {
          return { content: [{ type: "tool_use", id: "search-1", name: "ToolSearch", input: { query: "select:GuanlanSearch" } }], stopReason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      }
    }()
    const agent = createAgent({
      persistSession: false,
      tools: [tool("Read"), tool("GuanlanSearch"), tool("OtherSearch")],
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    // Query 1: ToolSearch promotes GuanlanSearch natively (turns 1-2).
    for await (const _event of agent.query("find guanlan")) {
      // drain query
    }
    // Query 2: the engine must receive the promoted tool natively, in append
    // order (the previously-sent prefix stays stable), and OtherSearch must
    // stay deferred.
    for await (const _event of agent.query("use it again")) {
      // drain query
    }

    expect(provider.requests[2]?.tools.map((item) => item.name)).toEqual([
      "Read", "ToolSearch", "ExecuteTool", "GuanlanSearch",
    ])
    expect((agent as any).toolPool.map((item: ToolDefinition) => item.name)).toContain("GuanlanSearch")
    expect((agent as any).deferredToolPool.map((item: ToolDefinition) => item.name)).toEqual(["OtherSearch"])

    // Promotions survive a pool rebuild (MCP reconnect etc.); names no longer
    // present in the pool are silently skipped.
    ;(agent as any).activatedToolNames.add("GoneTool")
    await (agent as any).rebuildToolPool()
    expect((agent as any).toolPool.map((item: ToolDefinition) => item.name)).toContain("GuanlanSearch")
    expect((agent as any).deferredToolPool.map((item: ToolDefinition) => item.name)).toEqual(["OtherSearch"])
    await agent.close()
  })

  test("appends promoted tools in match order so query boundaries keep a stable prefix", async () => {
    process.env.ENABLE_TOOL_SEARCH = "tst"
    const provider = new class implements LLMProvider {
      readonly apiType = "anthropic-messages" as const
      requests: CreateMessageParams[] = []
      async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
        this.requests.push(params)
        if (this.requests.length === 1) {
          return { content: [{ type: "tool_use", id: "search-1", name: "ToolSearch", input: { query: "beta" } }], stopReason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } }
        }
        return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      }
    }()
    // Deferred registration order [AlphaResearch, BetaResearch, GammaSearch];
    // keyword search scores BetaResearch (name match) above AlphaResearch
    // (description match), so the engine promotes them in match order
    // [BetaResearch, AlphaResearch] — not registration order.
    const agent = createAgent({
      persistSession: false,
      tools: [
        tool("Read"),
        { ...tool("AlphaResearch"), description: "Search the beta archive from the alpha era." },
        tool("BetaResearch"),
        tool("GammaSearch"),
      ],
    })
    await agent.getInitializationResult()
    ;(agent as any).provider = provider

    for await (const _event of agent.query("find beta")) {
      // drain query
    }
    for await (const _event of agent.query("use them again")) {
      // drain query
    }

    const expectedTail = ["Read", "ToolSearch", "ExecuteTool", "BetaResearch", "AlphaResearch"]
    // Within the run: the engine appends promotions in match order.
    expect(provider.requests[1]?.tools.map((item) => item.name)).toEqual(expectedTail)
    // Next query: the agent-side mirror must keep the same tail order.
    expect(provider.requests[2]?.tools.map((item) => item.name)).toEqual(expectedTail)
    expect((agent as any).toolPool.map((item: ToolDefinition) => item.name)).toEqual(expectedTail)
    expect((agent as any).deferredToolPool.map((item: ToolDefinition) => item.name)).toEqual(["GammaSearch"])

    // Rebuild keeps the activation-order tail (GammaSearch still deferred, so
    // the activated-append path runs).
    await (agent as any).rebuildToolPool()
    expect((agent as any).toolPool.map((item: ToolDefinition) => item.name)).toEqual(expectedTail)
    await agent.close()
  })

  test("keeps host-required runtime tools in the active schema", async () => {
    process.env.ENABLE_TOOL_SEARCH = "tst"
    const required = {
      ...tool("TaskReport"),
      runtimeMetadata: { requiredDuringSkillScope: true },
    }
    const agent = createAgent({
      persistSession: false,
      tools: [tool("Read"), required],
    })
    await agent.getInitializationResult()

    expect((agent as any).toolPool.map((item: ToolDefinition) => item.name)).toEqual(["Read", "TaskReport"])
    expect((agent as any).deferredToolPool).toEqual([])
    await agent.close()
  })

  test("keeps deferred tool discovery isolated between agent sessions", async () => {
    process.env.ENABLE_TOOL_SEARCH = "tst"
    const first = createAgent({ persistSession: false, tools: [tool("Read"), tool("PrivateAlpha")] })
    const second = createAgent({ persistSession: false, tools: [tool("Read"), tool("PrivateBeta")] })
    await Promise.all([first.getInitializationResult(), second.getInitializationResult()])

    const firstSearch = (first as any).toolPool.find((item: ToolDefinition) => item.name === "ToolSearch") as ToolDefinition
    const secondSearch = (second as any).toolPool.find((item: ToolDefinition) => item.name === "ToolSearch") as ToolDefinition
    const [firstResult, secondResult] = await Promise.all([
      firstSearch.call({ query: "select:PrivateAlpha" }, { cwd: process.cwd() }),
      secondSearch.call({ query: "select:PrivateAlpha" }, { cwd: process.cwd() }),
    ])

    expect(firstResult.content).toContain("PrivateAlpha")
    expect(secondResult.content).toContain("No tools found")
    await Promise.all([first.close(), second.close()])
  })

  test("keeps the complete tool list when deferred loading is explicitly disabled", async () => {
    process.env.ENABLE_TOOL_SEARCH = "standard"
    const agent = createAgent({ persistSession: false, tools: [tool("Read"), tool("PrivateResearch")] })
    await agent.getInitializationResult()

    expect((agent as any).toolPool.map((item: ToolDefinition) => item.name)).toEqual(["Read", "PrivateResearch"])
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
    expect(provider.requests[0]?.messages.filter((m: any) => m.role !== "runtime").at(-1)?.content).toBe("/skill hot-skill one")
    expect((agent as any).skillRegistry.get("hot-skill")?.invocationDescriptor.promptTemplate).toBe("First prompt: ${ARG}")

    writeSkill("Updated prompt: ${ARG}")
    for await (const _event of agent.query("/skill hot-skill two")) {
      // drain query
    }
    expect(provider.requests[1]?.messages.filter((m: any) => m.role !== "runtime").at(-1)?.content).toBe("/skill hot-skill two")
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

    expect(provider.requests[0]?.messages.filter((m: any) => m.role !== "runtime").at(-1)?.content).toBe("/code-review")

    for await (const _event of agent.query("src/index.ts")) {
      // drain query
    }

    expect(provider.requests[1]?.messages.filter((m: any) => m.role !== "runtime").at(-1)?.content).toBe("src/index.ts")
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

    expect(provider.requests[0]?.messages.filter((m: any) => m.role !== "runtime").at(-1)?.content).toBe("$code-review")

    for await (const _event of agent.query("src/index.ts")) {
      // drain query
    }

    expect(provider.requests[1]?.messages.filter((m: any) => m.role !== "runtime").at(-1)?.content).toBe("src/index.ts")
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
      provider: new StaticProvider(),
      contextController: {
        shouldAutoCompact: () => false,
        async compactConversation() {
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\ndurable compact summary" },
              { role: "user", content: "retained latest task" },
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
    expect(requestPayload).toContain("retained latest task")
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

describe("auth_status emission", () => {
  test("host-injected provider 不再发射 auth_status（软中止路径）", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({
      persistSession: false,
      tools: [],
      provider,
      model: "host/model-a",
    })
    const controller = new AbortController()
    controller.abort(new Error("stopped"))

    const events: SDKMessage[] = []
    for await (const event of agent.query("hello", { abortSignal: controller.signal })) {
      events.push(event)
    }

    expect(events.some((event) => event.type === "auth_status")).toBe(false)
    await agent.close()
  })

  test("未注入 provider 的运行入口 fail-fast，不产生任何事件流", async () => {
    const agent = createAgent({
      persistSession: false,
      tools: [],
      model: "host/model-a",
    })

    const drain = async () => {
      for await (const _event of agent.query("hello")) {
        // drain
      }
    }
    await expect(drain()).rejects.toThrow("No LLMProvider configured")

    await agent.close()
  })
})

describe("Agent concurrent run lock (#357)", () => {
  test("rejects a second query while the first run is still initializing", async () => {
    const provider = new CapturingProvider()
    const agent = createAgent({
      persistSession: false,
      tools: [],
      provider,
      model: "host/model-a",
    })
    await agent.getInitializationResult()

    const first = (agent.query("first") as any)[Symbol.asyncIterator]() as AsyncIterator<SDKMessage>
    const second = (agent.query("second") as any)[Symbol.asyncIterator]() as AsyncIterator<SDKMessage>
    // Start both generators in the same tick: the first one grabs the run
    // lock synchronously, so the second must be rejected before either
    // engine is even constructed.
    const firstStart = first.next()
    const secondOutcome = await second.next().then(
      () => "allowed",
      (error: Error) => error.message,
    )
    expect(secondOutcome).toBe("agent is running")

    // The first run completes normally.
    let done = await firstStart
    while (!done.done) {
      done = await first.next()
    }
    expect(provider.requests).toHaveLength(1)

    // The lock is released: a follow-up query runs fine.
    for await (const _event of agent.query("third")) {
      // drain
    }
    expect(provider.requests).toHaveLength(2)
    await agent.close()
  })
})

describe("Agent session message uuid realignment (#363)", () => {
  test("rebuilds session messages after a compaction boundary without rotating user uuids", async () => {
    const agent = createAgent({
      persistSession: false,
      tools: [],
      provider: new CapturingProvider(),
      model: "host/model-a",
    })
    await agent.getInitializationResult()

    for await (const _event of agent.query("checkpoint anchor request", {
      contextController: {
        shouldAutoCompact: () => true,
        async compactConversation() {
          return {
            compactedMessages: [
              { role: "user", content: "[Previous conversation summary]\n\nanchor summary" },
            ],
            summary: "anchor summary",
          }
        },
      },
    })) {
      // drain
    }

    const loggedUserUuid = ((agent.getMessages().find((message) => message.type === "user") as any) as { uuid: string }).uuid
    const rebuilt = (agent as any).sessionMessages as Array<{ uuid: string; role: string; content: unknown }>
    expect(rebuilt.map((message) => message.role)).toEqual(["user", "user", "assistant"])
    // The rebuilt latest user message keeps its original uuid, so
    // fileCheckpointState lookups keyed by that uuid still hit.
    expect(rebuilt[1]!.uuid).toBe(loggedUserUuid)
    expect(JSON.stringify(rebuilt[1]!.content)).toContain("checkpoint anchor request")

    await agent.close()
  })

  test("pairs roles from the end and falls back to fresh uuids past the old list", () => {
    const history = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ] as any[]
    const previous = [
      { uuid: "u-1", role: "user", timestamp: "t", content: "one" },
      { uuid: "a-1", role: "assistant", timestamp: "t", content: "two" },
    ] as any[]

    const rebuilt = sessionMessagesFromHistory(history, previous)

    // Trailing messages map onto the previous list; the leading extra user
    // (e.g. a synthetic compaction summary) gets a fresh uuid.
    expect(rebuilt.map((message) => message.uuid)).toEqual([expect.any(String), "a-1", "u-1"])
  })
})
>>>>>>> eb623a707 (🐛 fix(sdk): 会话运行同步锁与压缩重建 uuid 回填 (#357 #363))
