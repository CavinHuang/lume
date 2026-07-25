import { afterEach, describe, expect, test } from "bun:test"
import { QueryEngine } from "../engine.js"
import { AgentTool, clearAgents, registerAgents } from "./agent-tool.js"
import { ProcessOutputTool } from "./process-job-registry.js"
import { clearSkills, registerSkill } from "../skills/registry.js"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMProvider, CreateMessageParams, CreateMessageResponse, NormalizedTool } from "../providers/types.js"
import type { SDKMessage, ToolDefinition } from "../types.js"

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
    clearSkills()
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

  test("AgentTool auto-loads an agent default skill and applies its allowed tools", async () => {
    const observed: { system?: string; tools?: string[] } = {}
    const tempDir = join(tmpdir(), `lume-agent-default-skill-usage-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const skillDir = join(tempDir, "agent-writer")
    const skillPath = join(skillDir, "SKILL.md")
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
        observed.system = params.system
        observed.tools = (params.tools ?? []).map((tool: NormalizedTool) => tool.name).sort()
        return {
          content: [{ type: "text", text: "child done" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      }
    }
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillPath, "# Agent Writer\n", "utf-8")
    registerSkill({
      name: "agent-writer",
      description: "Writer workflow",
      sourcePath: skillPath,
      allowedTools: ["read_file"],
      getPrompt: async () => [{ type: "text", text: "AUTO-LOADED WRITER SOP" }]
    })
    registerAgents({
      "writer-test": {
        description: "writer",
        prompt: "BASE WRITER ROLE",
        defaultSkillName: "agent-writer",
        tools: ["Read", "Write", "Skill"]
      }
    })

    try {
      const result = await AgentTool.call({
        prompt: "write this",
        description: "write",
        subagent_type: "writer-test",
        mode: "bypassPermissions"
      }, {
        cwd: process.cwd(),
        provider,
        model: "test-model",
        apiType: "anthropic-messages",
        sessionId: "parent-thread"
      })

      expect(result.is_error).toBeFalsy()
      expect(observed.system).toContain("BASE WRITER ROLE")
      expect(observed.system).toContain("AUTO-LOADED WRITER SOP")
      expect(observed.tools).toContain("Read")
      expect(observed.tools).not.toContain("Write")
      expect(observed.tools).not.toContain("Skill")
      const usageRecords = readFileSync(join(skillDir, "usage.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(usageRecords).toEqual([{ ts: expect.any(Number), sessionId: "parent-thread" }])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("AgentTool annotates subagent result usage for parent runtime projection", async () => {
    const emitted: SDKMessage[] = []
    const provider = new StaticProvider([{
      content: [{ type: "text", text: "child done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 4 }
    }])

    const result = await AgentTool.call({
      prompt: "child task",
      description: "child",
      subagent_run_id: "child-run-1",
      mode: "bypassPermissions"
    }, {
      cwd: process.cwd(),
      provider,
      model: "test-model",
      apiType: "anthropic-messages",
      sessionId: "parent-thread",
      emitEvent: (event) => emitted.push(event)
    })

    expect(result.is_error).toBeFalsy()
    expect(emitted.find((event) => event.type === "result")).toMatchObject({
      type: "result",
      subagent_run_id: "child-run-1",
      session_id: "parent-thread",
      contextUsage: expect.objectContaining({
        totalTokens: 14
      }),
      billingUsage: expect.objectContaining({
        latestRecord: expect.objectContaining({
          outputTokens: 4,
          usageIdentity: expect.objectContaining({
            threadId: "child-run-1"
          })
        })
      })
    })
  })

  test("background inputs are exposed and return a task before subagent completion", async () => {
    expect(AgentTool.inputSchema.properties).toHaveProperty("run_in_background")
    expect(AgentTool.inputSchema.properties).toHaveProperty("isolation")

    let resolveResponse: ((response: CreateMessageResponse) => void) | undefined
    let endStarted = false
    const provider: LLMProvider = {
      apiType: "anthropic-messages",
      createMessage: async () => new Promise<CreateMessageResponse>((resolveResponsePromise) => {
        resolveResponse = resolveResponsePromise
      })
    }

    const pending = AgentTool.call({
      prompt: "legacy background child task",
      description: "background",
      subagent_run_id: "child-run-bg",
      mode: "bypassPermissions",
      run_in_background: true,
      isolation: "none"
    }, {
      cwd: process.cwd(),
      provider,
      model: "test-model",
      apiType: "anthropic-messages",
      sessionId: "parent-thread",
      onSubagentEnd: async () => {
        endStarted = true
      }
    })
    const started = await pending
    expect(started.is_error).toBeFalsy()
    expect(String(started.content)).toContain("Background agent started")
    const taskId = (started._meta?.task as { id?: string } | undefined)?.id
    expect(taskId).toBeString()

    await waitFor(() => resolveResponse !== undefined)
    resolveResponse?.({
      content: [{ type: "text", text: "child done" }],
      stopReason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 6 }
    })
    await waitFor(() => endStarted)
    const output = await ProcessOutputTool.call({ task_id: taskId, block: true, timeout: 1000 }, {
      cwd: process.cwd(),
      sessionId: "parent-thread",
    })
    expect(String(output.content)).toContain("child done")
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 500) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}
