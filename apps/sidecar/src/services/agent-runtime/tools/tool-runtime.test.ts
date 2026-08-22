import { describe, expect, test } from "bun:test";
import { createExecuteTool, createToolSearchTool, type ToolContext, type ToolDefinition } from "@lume/agent-sdk";
import type { LumeGuardrailRunner } from "../guardrails/guardrail-runner";
import { getRuntimeToolDescriptor } from "./tool-descriptor-session";
import { ToolExecutionGateway } from "./tool-execution-gateway";
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
    const taskReportDescriptor = getRuntimeToolDescriptor(sessionId, "TaskReport");
    expect(taskReportDescriptor?.metadata.allowedInPlanMode).toBe(true);
    const gateway = new ToolExecutionGateway({
      guardrails: {
        async runToolInputGuardrails() {
          return { behavior: "allow" };
        }
      } as unknown as LumeGuardrailRunner
    });
    await expect(gateway.authorize({
      toolName: "TaskReport",
      descriptor: taskReportDescriptor!,
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
    expect(getRuntimeToolDescriptor(sessionId, "TaskReport")?.definition).toBe(boundTaskReport);
    const context: ToolContext = { cwd: "/tmp", toolUseId: "task-report-collision" };
    await expect(tools[0]!.call({}, context)).resolves.toMatchObject({
      content: "bound"
    });
  });

  test("appends SDK-generated descriptors without dropping deferred tool descriptors", () => {
    const sessionId = `tool-runtime-generated-${crypto.randomUUID()}`;
    ToolRuntime.resolveDynamicTools({
      tools: [makeTool("Read"), makeTool("custom_search")],
      cwd: "/tmp",
      sessionId,
      policyInput: {}
    });

    ToolRuntime.registerGeneratedTools({
      tools: [createToolSearchTool(() => []), createExecuteTool(() => [])],
      sessionId
    });

    expect(getRuntimeToolDescriptor(sessionId, "custom_search")).toBeDefined();
    expect(getRuntimeToolDescriptor(sessionId, "ToolSearch")).toMatchObject({
      name: "ToolSearch",
      metadata: { allowedInPlanMode: true, requiresApprovalByDefault: false }
    });
    expect(getRuntimeToolDescriptor(sessionId, "ExecuteTool")).toMatchObject({
      name: "ExecuteTool",
      metadata: { allowedInPlanMode: true, requiresApprovalByDefault: false }
    });
  });
});
