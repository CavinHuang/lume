import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@lume/agent-sdk";
import { createToolDescriptorsFromDefinitions } from "./tool-source";
import { ToolRegistry } from "./tool-registry";

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

  test("uses runtime source metadata for command plugins without legacy read defaults", () => {
    const tool = {
      ...makeTool("PluginEcho"),
      runtimeMetadata: { source: "plugin", runtimeWrapped: true }
    };

    const registry = new ToolRegistry();
    registry.registerMany(createToolDescriptorsFromDefinitions([tool], "sdk"));

    expect(registry.get("PluginEcho")).toMatchObject({
      name: "PluginEcho",
      source: "plugin",
      metadata: {
        category: "control",
        capability: "plugin",
        riskLevel: "medium",
        sideEffects: "external",
        allowedInPlanMode: false,
        isReadOnly: false,
        isConcurrencySafe: false,
        requiresApprovalByDefault: true,
        resultPolicy: { maxChars: 200_000 }
      }
    });
  });

  test("infers Lume memory and automation tools as product-owned sources", () => {
    const registry = new ToolRegistry();
    registry.registerMany(createToolDescriptorsFromDefinitions([
      makeTool("memory.remember"),
      makeTool("automation_set")
    ], "lume"));

    expect(registry.get("memory.remember")).toMatchObject({
      source: "memory",
      metadata: expect.objectContaining({
        capability: "memory",
        category: "write"
      })
    });
    expect(registry.get("automation_set")).toMatchObject({
      source: "automation",
      metadata: expect.objectContaining({
        capability: "automation",
        category: "write"
      })
    });
  });

  test("preserves explicit plugin plan-safe metadata", () => {
    const tool = {
      ...makeTool("PluginEcho"),
      runtimeMetadata: {
        source: "plugin",
        category: "read",
        riskLevel: "low",
        allowedInPlanMode: true,
        isReadOnly: true,
        isConcurrencySafe: true,
        requiresApprovalByDefault: false
      }
    };

    const registry = new ToolRegistry();
    registry.registerMany(createToolDescriptorsFromDefinitions([tool], "sdk"));

    expect(registry.get("PluginEcho")?.metadata).toMatchObject({
      category: "read",
      riskLevel: "low",
      allowedInPlanMode: true,
      isReadOnly: true,
      isConcurrencySafe: true,
      requiresApprovalByDefault: false
    });
  });
});
