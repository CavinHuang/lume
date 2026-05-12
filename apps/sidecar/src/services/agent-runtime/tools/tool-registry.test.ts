import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@lume/agent-sdk";
import { ToolRegistry } from "./tool-registry";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    parameters: {
      type: "object" as const,
      properties: {}
    },
    async call() {
      return { type: "tool_result" as const, tool_use_id: "", content: "ok" };
    }
  } as unknown as ToolDefinition;
}

describe("ToolRegistry", () => {
  test("normalizes descriptors and keeps capability metadata with the tool definition", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "Read",
      source: "sdk",
      definition: makeTool("Read"),
      metadata: {
        category: "read",
        capability: "filesystem",
        riskLevel: "low",
        sideEffects: "local_read",
        allowedInPlanMode: true,
        isReadOnly: true,
        isConcurrencySafe: true
      }
    });

    expect(registry.get("read")).toMatchObject({
      canonicalName: "read",
      source: "sdk",
      metadata: {
        capability: "filesystem",
        isReadOnly: true
      },
      definition: expect.objectContaining({ name: "Read" })
    });
  });

  test("unknown tools are registered fail-closed when metadata is omitted", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "externalDanger",
      source: "mcp",
      definition: makeTool("externalDanger")
    });

    expect(registry.get("externalDanger")).toMatchObject({
      canonicalName: "externaldanger",
      source: "mcp",
      metadata: {
        category: "control",
        capability: "mcp",
        riskLevel: "medium",
        sideEffects: "external",
        allowedInPlanMode: false,
        isReadOnly: false,
        isConcurrencySafe: false,
        requiresApprovalByDefault: true
      }
    });
  });
});
