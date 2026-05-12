import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@lume/agent-sdk";
import { createToolDescriptorsFromDefinitions } from "./tool-source";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties: {}
    },
    async call() {
      return { type: "tool_result" as const, tool_use_id: "", content: "ok" };
    }
  } as unknown as ToolDefinition;
}

describe("createToolDescriptorsFromDefinitions", () => {
  test("enriches SDK tools with runtime metadata", () => {
    expect(createToolDescriptorsFromDefinitions([makeTool("Read"), makeTool("Bash")], "sdk"))
      .toEqual([
        expect.objectContaining({
          name: "Read",
          source: "sdk",
          metadata: expect.objectContaining({
            category: "read",
            capability: "filesystem",
            riskLevel: "low",
            isReadOnly: true,
            allowedInPlanMode: true
          })
        }),
        expect.objectContaining({
          name: "Bash",
          source: "sdk",
          metadata: expect.objectContaining({
            category: "execute",
            capability: "shell",
            riskLevel: "high",
            isReadOnly: false,
            allowedInPlanMode: false
          })
        })
      ]);
  });
});
