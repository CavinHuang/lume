import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../types";
import { applyOverrides, createToolRegistry } from "./registry.js";
import { CORE_TOOL_NAMES } from "./index.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    call: async () => ({ type: "tool_result", tool_use_id: "", content: name }),
  };
}

describe("tool registry", () => {
  test("global tools are visible", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("Read")]);
    expect(registry.agent("a1").view().visible().map((t) => t.name)).toEqual(["Bash", "Read"]);
  });

  test("agent layer shadows same-name global tool", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash")]);
    const sandboxed = tool("Bash");
    sandboxed.description = "sandboxed";
    registry.agent("a1").register([sandboxed]);
    const visible = registry.agent("a1").view().visible();
    expect(visible).toHaveLength(1);
    expect(visible[0].description).toBe("sandboxed");
  });

  test("deny masks union across layers, allow masks intersect", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("Read"), tool("WebFetch")]);
    registry.preset("default").restrict({ allow: ["Bash", "Read", "WebFetch"] });
    registry.agent("a1").restrict({ deny: ["WebFetch"] });
    expect(registry.agent("a1").view().visible().map((t) => t.name)).toEqual(["Bash", "Read"]);
  });

  test("layers are isolated per agent", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash")]);
    registry.agent("a1").restrict({ deny: ["Bash"] });
    expect(registry.agent("a2").view().visible().map((t) => t.name)).toEqual(["Bash"]);
  });

  test("register and restrict disposers undo their effect", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash")]);
    const undo = registry.agent("a1").restrict({ deny: ["Bash"] });
    undo();
    expect(registry.agent("a1").view().visible().map((t) => t.name)).toEqual(["Bash"]);
  });

  test("split uses nearest setCore plus requiredDuringSkillScope", () => {
    const registry = createToolRegistry();
    const skillTool = tool("GuanlanSearch");
    skillTool.runtimeMetadata = { requiredDuringSkillScope: true } as never;
    registry.global.register([tool("Bash"), tool("WebFetch"), skillTool]);
    registry.preset("default").setCore(["Bash"]);
    const { core, deferred } = registry.agent("a1").view().split();
    expect(core.map((t) => t.name).sort()).toEqual(["Bash", "GuanlanSearch"]);
    expect(deferred.map((t) => t.name)).toEqual(["WebFetch"]);
  });

  test("agent setCore shadows preset setCore", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("WebFetch")]);
    registry.preset("default").setCore(["Bash"]);
    registry.agent("a1").setCore(["WebFetch"]);
    const { core } = registry.agent("a1").view().split();
    expect(core.map((t) => t.name)).toEqual(["WebFetch"]);
  });

  test("ToolSearch and ExecuteTool never appear in split results", () => {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("ToolSearch"), tool("ExecuteTool")]);
    const view = registry.agent("a1").view();
    const names = [...view.split().core, ...view.split().deferred].map((t) => t.name);
    expect(names).not.toContain("ToolSearch");
    expect(names).not.toContain("ExecuteTool");
  });
});

describe("CORE_TOOL_NAMES preset", () => {
  test("CORE_TOOL_NAMES stays the default preset core set", () => {
    expect(CORE_TOOL_NAMES.has("Bash")).toBe(true);
    expect(CORE_TOOL_NAMES.has("WebFetch")).toBe(true);
  });
});

describe("applyOverrides", () => {
  function setup() {
    const registry = createToolRegistry();
    registry.global.register([tool("Bash"), tool("WebFetch"), tool("GuanlanSearch")]);
    registry.preset("default").setCore(["Bash"]);
    return registry;
  }

  test("no overrides returns the unmasked view", () => {
    const registry = setup();
    const { tools, deferredTools, undo } = applyOverrides(registry, "a1", undefined);
    expect(tools.map((t) => t.name)).toEqual(["Bash", "WebFetch", "GuanlanSearch"]);
    expect(deferredTools.map((t) => t.name)).toEqual(["WebFetch", "GuanlanSearch"]);
    undo();
  });

  test("disallowedTools masks both pools", () => {
    const registry = setup();
    const { tools, deferredTools, undo } = applyOverrides(registry, "a1", { disallowedTools: ["Web*"] });
    expect(tools.map((t) => t.name)).toContain("Bash");
    expect(tools.map((t) => t.name)).not.toContain("WebFetch");
    expect(deferredTools.map((t) => t.name)).not.toContain("WebFetch");
    undo();
    expect(registry.agent("a1").view().visible().map((t) => t.name)).toContain("WebFetch");
  });

  test("string tool list becomes allow mask and clears deferred", () => {
    const registry = setup();
    const { tools, deferredTools } = applyOverrides(registry, "a1", { tools: ["Bash"] });
    expect(tools.map((t) => t.name)).toEqual(["Bash"]);
    expect(deferredTools).toEqual([]);
  });

  test("tool definition array replaces tools outright", () => {
    const registry = setup();
    const custom = tool("Custom");
    const { tools, deferredTools } = applyOverrides(registry, "a1", { tools: [custom] });
    expect(tools).toEqual([custom]);
    expect(deferredTools).toEqual([]);
  });

  test("empty tools array yields empty pools", () => {
    const registry = setup();
    const { tools, deferredTools } = applyOverrides(registry, "a1", { tools: [] });
    expect(tools).toEqual([]);
    expect(deferredTools).toEqual([]);
  });

  test("deny with pools filters the live pools and keeps eager-only tools", () => {
    const registry = setup();
    const pools = {
      tools: [tool("Bash"), tool("ToolSearch")],
      deferredTools: [tool("WebFetch"), tool("GuanlanSearch")],
    };
    const { tools, deferredTools } = applyOverrides(registry, "a1", { disallowedTools: ["Web*"] }, pools);
    expect(tools.map((t) => t.name)).toEqual(["Bash", "ToolSearch"]);
    expect(deferredTools.map((t) => t.name)).toEqual(["GuanlanSearch"]);
  });

  test("string list plus disallowedTools intersects allow with deny", () => {
    const registry = setup();
    const pools = { tools: [tool("Bash")], deferredTools: [tool("WebFetch")] };
    const { tools, deferredTools } = applyOverrides(
      registry,
      "a1",
      { tools: ["Bash", "WebFetch"], disallowedTools: ["Web*"] },
      pools,
    );
    expect(tools.map((t) => t.name)).toEqual(["Bash"]);
    expect(deferredTools).toEqual([]);
  });

  test("preset-object tools with pools applies deny to pools and clears deferred", () => {
    const registry = setup();
    const pools = {
      tools: [tool("Bash"), tool("WebFetch"), tool("ToolSearch")],
      deferredTools: [tool("GuanlanSearch")],
    };
    const { tools, deferredTools } = applyOverrides(
      registry,
      "a1",
      { tools: { type: "preset", preset: "default" }, disallowedTools: ["Web*"] },
      pools,
    );
    expect(tools.map((t) => t.name)).toEqual(["Bash", "ToolSearch"]);
    expect(deferredTools).toEqual([]);
  });
});
