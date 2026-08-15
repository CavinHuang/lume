// packages/sdk/src/agent-resume.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgent } from "./agent.js"
import { saveSession } from "./session.js"
import { buildResumeContinuations, type DanglingToolUse } from "./interrupt-recovery.js"
import type { ToolDefinition } from "./types.js"
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from "./providers/types.js"

const tempDirs: string[] = []
const originalSdkHome = process.env.OPEN_AGENT_SDK_HOME

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (originalSdkHome === undefined) {
    delete process.env.OPEN_AGENT_SDK_HOME
  } else {
    process.env.OPEN_AGENT_SDK_HOME = originalSdkHome
  }
})

class CapturingProvider implements LLMProvider {
  readonly apiType = "anthropic-messages" as const
  requests: CreateMessageParams[] = []

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.requests.push(params)
    return {
      content: [{ type: "text", text: "resumed" }],
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

const INTERRUPTED_PLACEHOLDER =
  "Error: interrupted before completion; actual state unknown — inspect the workspace before retrying."

describe("buildResumeContinuations", () => {
  const dangling: DanglingToolUse[] = [
    { id: "r1", name: "Read", input: { path: "a" } },
    { id: "w1", name: "Edit", input: { path: "b" } },
  ]

  test("read-only tools replay; side-effect tools get interrupted placeholder", () => {
    const continuations = buildResumeContinuations(dangling, {
      isReadOnly: (name) => name === "Read",
    })
    expect(continuations).toEqual([
      { toolCall: { id: "r1", name: "Read", input: { path: "a" } } },
      {
        toolCall: { id: "w1", name: "Edit", input: { path: "b" } },
        toolResult: {
          type: "tool_result",
          tool_use_id: "w1",
          content: INTERRUPTED_PLACEHOLDER,
          is_error: true,
        },
      },
    ])
  })

  test("unknown tools are treated as side-effect and never replayed", () => {
    const continuations = buildResumeContinuations(
      [{ id: "x1", name: "Mystery", input: {} }],
      { isReadOnly: () => false },
    )
    expect(continuations).toHaveLength(1)
    expect(continuations[0]?.toolResult?.is_error).toBe(true)
    expect(continuations[0]?.toolCall).toEqual({ id: "x1", name: "Mystery", input: {} })
  })

  test("dedupes duplicate tool_call ids keeping the first occurrence", () => {
    const continuations = buildResumeContinuations(
      [
        { id: "dup", name: "Read", input: { path: "first" } },
        { id: "dup", name: "Read", input: { path: "second" } },
      ],
      { isReadOnly: () => true },
    )
    expect(continuations).toEqual([
      { toolCall: { id: "dup", name: "Read", input: { path: "first" } } },
    ])
  })
})

describe("Agent.resumeInterruptedRun", () => {
  test("resumes a dangling run even when called before setup finishes", async () => {
    // Regression: detect-before-await-setupDone saw history=[] and silently
    // no-op'd the resume for a freshly constructed Agent.
    const tempDir = mkdtempSync(join(tmpdir(), "sdk-agent-resume-race-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `resume-race-${crypto.randomUUID()}`

    await saveSession(sessionId, [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-dangle-1", name: "Read", input: { file_path: "a.ts" } }],
      },
      // tool-dangle-1 has no tool_result → dangling
    ], { cwd: tempDir, model: "test-model" })

    const provider = new CapturingProvider()
    const readTool: ToolDefinition = {
      name: "Read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: () => true,
      async call() {
        return { type: "tool_result", tool_use_id: "", content: "replayed content" }
      },
    }
    const agent = createAgent({
      resume: sessionId,
      persistSession: false,
      tools: [readTool],
      cwd: tempDir,
      model: "test-model",
      provider,
    })

    // No await on getInitializationResult(): resume must await setup itself.
    for await (const _event of agent.resumeInterruptedRun()) {
      // drain
    }

    expect(provider.requests).toHaveLength(1)
    const payload = JSON.stringify(provider.requests[0]?.messages)
    expect(payload).toContain("tool-dangle-1")
    expect(payload).toContain("replayed content")
    await agent.close()
  })
})

describe("Agent dangling history repair on next prompt", () => {
  test("a plain prompt fills placeholders for crashed-run dangling tool_use before the provider request", async () => {
    // Regression (C2): message-level persistence lets a crashed run's trailing
    // assistant tool_use survive on disk with no tool_result. The next user
    // message must repair the pairing instead of sending a rejected request.
    const tempDir = mkdtempSync(join(tmpdir(), "sdk-agent-repair-"))
    tempDirs.push(tempDir)
    process.env.OPEN_AGENT_SDK_HOME = join(tempDir, "sdk-home")
    const sessionId = `repair-${crypto.randomUUID()}`

    await saveSession(sessionId, [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-crash-1", name: "Bash", input: { command: "ls" } }],
      },
      // tool-crash-1 has no tool_result → dangling after a crash
    ], { cwd: tempDir, model: "test-model" })

    const provider = new CapturingProvider()
    const agent = createAgent({
      resume: sessionId,
      persistSession: false,
      cwd: tempDir,
      model: "test-model",
      provider,
    })

    await agent.prompt("continue")

    expect(provider.requests).toHaveLength(1)
    const payload = JSON.stringify(provider.requests[0]?.messages)
    const results = payload.match(/"tool_use_id":\s*"tool-crash-1"/g) ?? []
    expect(results).toHaveLength(1)
    expect(payload).toContain("interrupted before completion")
    await agent.close()
  })
})
