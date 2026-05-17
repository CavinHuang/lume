import { describe, expect, test } from "bun:test"
import { createAgent } from "./agent.js"
import type { ToolDefinition } from "./types.js"

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
