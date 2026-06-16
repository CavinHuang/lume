import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@lume/agent-sdk";
import { ToolRuntime } from "./tool-runtime";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {} },
    async call() {
      return { type: "tool_result", tool_use_id: "", content: "ok" };
    }
  } as ToolDefinition;
}

describe("ToolRuntime", () => {
  test("build owns descriptor registration and runtime wrapping", () => {
    const result = ToolRuntime.build({
      cwd: "/tmp",
      sessionId: `tool-runtime-${crypto.randomUUID()}`,
      permissionMode: "plan",
      policyInput: {},
      groups: [{
        source: "sdk",
        tools: [makeTool("Read"), makeTool("Write")]
      }]
    });

    expect(result.availableToolNames).toEqual(["Read"]);
    expect(result.descriptorsByCanonicalName.get("read")?.metadata.allowedInPlanMode).toBe(true);
    expect((result.tools[0] as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata).toMatchObject({
      runtimeWrapped: true
    });
  });
});
