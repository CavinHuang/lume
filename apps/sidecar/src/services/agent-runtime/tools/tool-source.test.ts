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

  test("definition-level isReadOnly wins over category inference (both shapes)", () => {
    // FinishAgentTask 形状：control/low 注册 + 定义体显式 isReadOnly:false——
    // 推断类别（control）不得把定义体的 false 覆盖回 true。
    // defineTool 会把布尔规范化为函数形态，两种声明形态都必须被识别。
    // 声明 true 的反向用例见下一个 test。
    const descriptors = createToolDescriptorsFromDefinitions([
      { ...makeTool("AskUserQuestion"), isReadOnly: false } as unknown as ToolDefinition,
      { ...makeTool("TodoWrite"), isReadOnly: () => false } as unknown as ToolDefinition,
    ], "sdk");

    expect(descriptors.map((descriptor) => descriptor.metadata)).toEqual([
      expect.objectContaining({ isReadOnly: false, category: "control", riskLevel: "low" }),
      expect.objectContaining({ isReadOnly: false, category: "control", riskLevel: "low" }),
    ]);
  });

  test("a truthy declared isReadOnly also survives control-category inference", () => {
    const tool = { ...makeTool("AskUserQuestion"), isReadOnly: () => true } as unknown as ToolDefinition;

    const registry = new ToolRegistry();
    registry.registerMany(createToolDescriptorsFromDefinitions([tool], "sdk"));

    expect(registry.get("AskUserQuestion")?.metadata.isReadOnly).toBe(true);
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

  test("mcp/plugin descriptors honor definition-level isReadOnly (symmetry with sdk branch)", () => {
    // review 发现：sdk 分支尊重定义体声明，mcp/plugin 分支此前忽略——补齐对称。
    // 无声明时维持原状（不引入推断），runtimeMetadata 仍可覆盖。
    // （断言落在 descriptor 原始 metadata 上：ToolRegistry 注册时会补
    // defaultMetadataForSource 默认值，isReadOnly 在那里永远非 undefined。）
    const declared = { ...makeTool("PluginEcho"), isReadOnly: false } as unknown as ToolDefinition;
    const undeclared = makeTool("PluginEcho");

    const declaredReadOnly = createToolDescriptorsFromDefinitions([declared], "plugin")[0]?.metadata?.isReadOnly;
    expect(declaredReadOnly).toBe(false);

    const undeclaredReadOnly = createToolDescriptorsFromDefinitions([undeclared], "plugin")[0]?.metadata?.isReadOnly;
    expect(undeclaredReadOnly).toBeUndefined();
  });
});
