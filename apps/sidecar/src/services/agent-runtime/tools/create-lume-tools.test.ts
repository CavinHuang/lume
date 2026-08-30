import { describe, expect, test } from "bun:test";
import { createLumeRuntimeTools } from "./create-lume-tools";
import { createToolDescriptorsFromDefinitions } from "./tool-source";
import { ToolRegistry } from "./tool-registry";
import { ToolResolver } from "./tool-resolver";

function baseInput() {
  return {
    threadId: "thread-1",
    includeCitations: true,
    emitAskUserQuestion: () => undefined,
    emitToolPermissionRequest: () => undefined
  };
}

describe("create-lume-tools", () => {
  test("includes the IM reply tool for all runtime threads", () => {
    const result = createLumeRuntimeTools(baseInput());

    expect(result.customTools.map((tool) => tool.name)).toContain("send_im_message");
    expect(result.customTools.map((t) => t.name)).toContain("send_im_message");
  });

  test("includes the suggestion_analyze builtin tool for runtime threads", () => {
    const result = createLumeRuntimeTools(baseInput());

    expect(result.customTools.map((tool) => tool.name)).toContain("suggestion_analyze");
    expect(result.customTools.map((t) => t.name)).toContain("suggestion_analyze");
  });

  test("includes Alice-style WeRead reading workflow tools", () => {
    const result = createLumeRuntimeTools(baseInput());
    const toolNames = result.customTools.map((tool) => tool.name);

    expect(toolNames).toContain("weread_generate_note");
    expect(toolNames).toContain("weread_export_all_notes");
    expect(result.customTools.map((t) => t.name)).toContain("weread_generate_note");
    expect(result.customTools.map((t) => t.name)).toContain("weread_export_all_notes");
  });

  test("registers Computer Use tools independently of message wording", () => {
    const result = createLumeRuntimeTools({ ...baseInput(), workspaceSlug: "workspace-1" });
    const toolNames = result.customTools.map((tool) => tool.name);

    expect(toolNames).toContain("mcp__node_repl__js");
    expect(toolNames).toContain("mcp__node_repl__js_reset");
    expect(toolNames).toContain("mcp__node_repl__js_add_node_module_dir");
    expect(result.customTools.map((t) => t.name)).toContain("mcp__node_repl__js");
    expect(toolNames.some((name) => name.startsWith("mcp__computer_use__"))).toBeTrue();
    expect(toolNames).not.toContain("js");
  });

  test("does not mark the node_repl executor as a permanently visible core tool", () => {
    const result = createLumeRuntimeTools({
      ...baseInput(),
      workspaceSlug: "workspace-1",
      originalUserInstruction: "使用浏览器在百度中搜索 agent"
    });

    const nodeRepl = result.customTools.find((tool) => tool.name === "mcp__node_repl__js");
    expect(nodeRepl).toBeDefined();
    expect(nodeRepl?.runtimeMetadata?.requiredDuringSkillScope).not.toBeTrue();
  });

  test("does not hide mixed capabilities from a coding request", () => {
    const result = createLumeRuntimeTools({
      ...baseInput(),
      originalUserInstruction: "修复浏览器页面的弹窗层级问题"
    });
    const toolNames = result.customTools.map((tool) => tool.name);
    expect(result.customTools.map((t) => t.name)).toContain("automation_read");
    expect(toolNames.some((name) => name.startsWith("mcp__computer_use__"))).toBeTrue();
    expect(toolNames.some((name) => name.startsWith("mcp__node_repl__"))).toBeTrue();
  });

  test("exposes only node_repl for the sky Computer Use surface", () => {
    const result = createLumeRuntimeTools({ ...baseInput(), computerUseSurface: "sky" });
    const toolNames = result.customTools.map((tool) => tool.name);

    expect(toolNames).toContain("mcp__node_repl__js");
    expect(toolNames).not.toContain("mcp__node_repl__js_reset");
    expect(toolNames).not.toContain("mcp__node_repl__js_add_node_module_dir");
    expect(toolNames.some((name) => name.startsWith("mcp__computer_use__"))).toBeFalse();
    expect(result.customTools.some((tool) => tool.name.startsWith("mcp__computer_use__"))).toBeFalse();
  });

});
