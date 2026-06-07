import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@lume/agent-sdk";
import type { AgentToolPolicy } from "@lume/shared";
import { ToolRegistry } from "./tool-registry";
import { ToolResolver } from "./tool-resolver";
import type { LumeToolCategory, LumeToolDescriptorInput } from "./tool-types";

function tool(input: {
  name: string;
  category: LumeToolCategory;
  allowedInPlanMode: boolean;
  isReadOnly: boolean;
}): LumeToolDescriptorInput {
  return {
    name: input.name,
    source: "sdk",
    definition: {
      name: input.name,
      description: `${input.name} test tool`,
      parameters: {
        type: "object",
        properties: {}
      },
      async call() {
        return { type: "tool_result" as const, tool_use_id: "", content: "ok" };
      }
    } as unknown as ToolDefinition,
    metadata: {
      category: input.category,
      capability: input.category === "execute" ? "shell" : "filesystem",
      riskLevel: input.category === "read" ? "low" : "medium",
      sideEffects: input.category === "read" ? "local_read" : "local_write",
      allowedInPlanMode: input.allowedInPlanMode,
      isReadOnly: input.isReadOnly,
      isConcurrencySafe: input.isReadOnly
    }
  };
}

describe("ToolResolver", () => {
  test("uses descriptor metadata as the plan-mode visibility source of truth", () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      tool({ name: "Read", category: "read", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "Write", category: "write", allowedInPlanMode: false, isReadOnly: false }),
      tool({ name: "Bash", category: "execute", allowedInPlanMode: false, isReadOnly: false })
    ]);

    const resolver = new ToolResolver(registry);

    expect(resolver.resolve({ permissionMode: "plan" }).map((item) => item.name)).toEqual(["Read"]);
  });

  test("applies run metadata tool policy after mode visibility", () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      tool({ name: "Read", category: "read", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "Grep", category: "read", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "Write", category: "write", allowedInPlanMode: false, isReadOnly: false })
    ]);

    const policy: AgentToolPolicy = {
      allow: ["Read", "Write"],
      deny: ["Write"]
    };
    const resolver = new ToolResolver(registry);

    expect(resolver.resolve({
      permissionMode: "default",
      messageMetadata: { toolPolicy: policy }
    }).map((item) => item.name)).toEqual(["Read"]);
  });

  test("supports group and wildcard visibility policies", () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      tool({ name: "Read", category: "read", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "Write", category: "write", allowedInPlanMode: false, isReadOnly: false }),
      tool({ name: "WebSearch", category: "network", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "WebFetch", category: "network", allowedInPlanMode: true, isReadOnly: true })
    ]);
    const resolver = new ToolResolver(registry);

    expect(resolver.resolve({
      policies: [{ allow: ["group:fs", "web_*"], deny: ["Write"] }]
    }).map((item) => item.name)).toEqual(["Read", "WebSearch", "WebFetch"]);
  });

  test("keeps web and data-query policy groups independent", () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      tool({ name: "web_search", category: "network", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "web_fetch", category: "network", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "guanlan_search", category: "network", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "guanlan_research", category: "network", allowedInPlanMode: true, isReadOnly: true })
    ]);
    const resolver = new ToolResolver(registry);

    expect(resolver.resolve({
      policies: [{ deny: ["group:web"] }]
    }).map((item) => item.name)).toEqual(["guanlan_search", "guanlan_research"]);
    expect(resolver.resolve({
      policies: [{ deny: ["group:data"] }]
    }).map((item) => item.name)).toEqual(["web_search", "web_fetch"]);
  });

  test("planning group keeps clarification and plan submission tools together", () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      tool({ name: "AskUserQuestion", category: "control", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "TaskContractWrite", category: "control", allowedInPlanMode: true, isReadOnly: false }),
      tool({ name: "TaskReport", category: "control", allowedInPlanMode: false, isReadOnly: false }),
      tool({ name: "Read", category: "read", allowedInPlanMode: true, isReadOnly: true })
    ]);
    const resolver = new ToolResolver(registry);

    expect(resolver.resolve({
      permissionMode: "plan",
      policies: [{ allow: ["group:planning"] }]
    }).map((item) => item.name)).toEqual(["AskUserQuestion", "TaskContractWrite"]);
  });

  test("evolution group controls UI personalization tools", () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      tool({ name: "personalize_ui", category: "write", allowedInPlanMode: false, isReadOnly: false }),
      tool({ name: "Read", category: "read", allowedInPlanMode: true, isReadOnly: true })
    ]);
    const resolver = new ToolResolver(registry);

    expect(resolver.resolve({
      policies: [{ deny: ["group:evolution"] }]
    }).map((item) => item.name)).toEqual(["Read"]);
  });

  test("office group controls Office document tools", () => {
    const registry = new ToolRegistry();
    registry.registerMany([
      tool({ name: "office_validate", category: "read", allowedInPlanMode: true, isReadOnly: true }),
      tool({ name: "office_unpack", category: "write", allowedInPlanMode: false, isReadOnly: false }),
      tool({ name: "Read", category: "read", allowedInPlanMode: true, isReadOnly: true })
    ]);
    const resolver = new ToolResolver(registry);

    expect(resolver.resolve({
      policies: [{ deny: ["group:office"] }]
    }).map((item) => item.name)).toEqual(["Read"]);
  });
});
