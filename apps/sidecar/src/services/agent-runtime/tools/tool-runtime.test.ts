import { describe, expect, test } from "bun:test";
import { createExecuteTool, createToolSearchTool, type ToolContext, type ToolDefinition } from "@lume/agent-sdk";
import type { LumeGuardrailRunner } from "../guardrails/guardrail-runner";
import type { LumeToolDescriptor, LumeToolMetadata } from "./tool-types";
import { ToolExecutionGateway } from "./tool-execution-gateway";
import { ToolRuntime } from "./tool-runtime";

// 双载体合一（#541）：descriptor 元数据随 wrapped definition 的 runtimeMetadata 携带
function stampedMetadata(tool: ToolDefinition): Record<string, unknown> {
  return (tool as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata ?? {};
}

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

  test("required tools bypass visibility filtering but retain descriptors and runtime wrapping", async () => {
    const sessionId = `tool-runtime-required-${crypto.randomUUID()}`;
    const tools = ToolRuntime.resolveDynamicTools({
      tools: [makeTool("Read")],
      requiredTools: [makeTool("TaskReport")],
      cwd: "/tmp",
      sessionId,
      permissionMode: "plan",
      messageMetadata: { toolPolicy: { deny: ["TaskReport"] } },
      policyInput: {}
    });

    expect(tools.map((tool) => tool.name)).toEqual(["Read", "TaskReport"]);
    const taskReportDescriptor: LumeToolDescriptor = {
      name: "TaskReport",
      canonicalName: "taskreport",
      source: "task",
      definition: tools[1]!,
      metadata: stampedMetadata(tools[1]!) as unknown as LumeToolMetadata
    };
    expect(taskReportDescriptor.metadata.allowedInPlanMode).toBe(true);
    const gateway = new ToolExecutionGateway({
      guardrails: {
        async runToolInputGuardrails() {
          return { behavior: "allow" };
        }
      } as unknown as LumeGuardrailRunner
    });
    await expect(gateway.authorize({
      toolName: "TaskReport",
      descriptor: taskReportDescriptor,
      input: { status: "submitted", summary: "done" },
      permissionMode: "plan",
      context: { threadId: sessionId, cwd: "/tmp" }
    })).resolves.toMatchObject({ status: "allow" });
    expect((tools[1] as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata).toMatchObject({
      requiredDuringSkillScope: true,
      runtimeWrapped: true
    });
  });

  test("required tools replace dynamic tools with the same canonical name", async () => {
    const sessionId = `tool-runtime-required-collision-${crypto.randomUUID()}`;
    const genericTaskReport = {
      ...makeTool("TaskReport"),
      description: "generic TaskReport",
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "generic" };
      }
    } as ToolDefinition;
    const boundTaskReport = {
      ...makeTool("TaskReport"),
      description: "bound TaskReport",
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "bound" };
      }
    } as ToolDefinition;

    const tools = ToolRuntime.resolveDynamicTools({
      tools: [genericTaskReport],
      requiredTools: [boundTaskReport],
      cwd: "/tmp",
      sessionId,
      policyInput: {}
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("TaskReport");
    expect((tools[0] as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata).toMatchObject({
      runtimeWrapped: true
    });
    const context: ToolContext = { cwd: "/tmp", toolUseId: "task-report-collision" };
    await expect(tools[0]!.call({}, context)).resolves.toMatchObject({
      content: "bound"
    });
  });

  test("generated ToolSearch/ExecuteTool carry self-contained runtimeMetadata for canUseTool (#541)", () => {
    // 双载体合一后旁路注册已删：生成工具的定义自带盖章数据，canUseTool 直接取回
    for (const tool of [createToolSearchTool(() => []), createExecuteTool(() => [])]) {
      const meta = stampedMetadata(tool);
      expect(meta).toMatchObject({
        source: "sdk",
        allowedInPlanMode: true,
        requiresApprovalByDefault: false
      });
    }
  });

  test("runtimeWrapped short-circuit still strips declared delegatesPermission (#711 review)", () => {
    // 第三层防线钉：自声明 runtimeWrapped:true 跳过 wrapper 时，豁免键仍被剥离——
    // 回归删除会重开「manifest 一个字段免审免拦」通道
    const sneaky: ToolDefinition = {
      name: "Sneaky",
      description: "self-declared wrapped + delegates",
      inputSchema: { type: "object", properties: {} },
      runtimeMetadata: { runtimeWrapped: true, delegatesPermission: true, source: "plugin" },
      async call() {
        return { type: "tool_result", tool_use_id: "", content: "ok" };
      }
    };
    const tools = ToolRuntime.build({
      cwd: "/tmp",
      sessionId: `tool-runtime-sneaky-${crypto.randomUUID()}`,
      policyInput: {},
      groups: [{ source: "plugin", tools: [sneaky] }]
    });

    const meta = stampedMetadata(tools.tools[0]!);
    expect(meta.delegatesPermission).toBeUndefined();
    expect(meta.runtimeWrapped).toBe(true);
    expect(meta.source).toBe("plugin");
  });

  test("AskUserQuestion is wrapped like any other tool so its descriptor rides on the definition (#541)", () => {
    const result = ToolRuntime.build({
      cwd: "/tmp",
      sessionId: `tool-runtime-askuser-${crypto.randomUUID()}`,
      policyInput: {},
      groups: [{
        source: "sdk",
        tools: [makeTool("AskUserQuestion")]
      }]
    });

    expect(stampedMetadata(result.tools[0]!)).toMatchObject({
      runtimeWrapped: true,
      canonicalName: "askuserquestion"
    });
  });
});
