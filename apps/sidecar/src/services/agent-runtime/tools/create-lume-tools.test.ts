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

  test("registers Browser and Computer Use tools independently of message wording", () => {
    const result = createLumeRuntimeTools({ ...baseInput(), workspaceSlug: "workspace-1" });
    const toolNames = result.customTools.map((tool) => tool.name);

    expect(toolNames).toContain("mcp__node_repl__js");
    expect(toolNames).toContain("mcp__node_repl__js_reset");
    expect(toolNames).toContain("mcp__node_repl__js_add_node_module_dir");
    expect(result.customTools.map((t) => t.name)).toContain("mcp__node_repl__js");
    expect(toolNames.some((name) => name.startsWith("mcp__computer_use__"))).toBeTrue();
    expect(toolNames).not.toContain("js");
    expect(toolNames).toContain("mcp__browser__list_tabs");
    expect(toolNames).toContain("mcp__browser__open");
    expect(toolNames).toContain("mcp__browser__switch_tab");
    expect(toolNames).toContain("mcp__browser__navigate");
    expect(toolNames).toContain("mcp__browser__back");
    expect(toolNames).toContain("mcp__browser__forward");
    expect(toolNames).toContain("mcp__browser__reload");
    expect(toolNames).toContain("mcp__browser__snapshot");
    expect(toolNames).toContain("mcp__browser__click");
    expect(toolNames).toContain("mcp__browser__fill");
    expect(toolNames).toContain("mcp__browser__type");
    expect(toolNames).toContain("mcp__browser__press");
    expect(toolNames).toContain("mcp__browser__select");
    expect(toolNames).toContain("mcp__browser__check");
    expect(toolNames).toContain("mcp__browser__scroll");
    expect(toolNames).toContain("mcp__browser__screenshot");
    expect(toolNames).toContain("mcp__browser__upload");
    expect(toolNames).toContain("mcp__browser__download");
    expect(toolNames).toContain("mcp__browser__list_secrets");
    expect(toolNames).toContain("mcp__browser__fill_secret");
    expect(toolNames).toContain("mcp__browser__dialog");
    expect(toolNames).toContain("mcp__browser__handle_dialog");
    expect(toolNames).toContain("mcp__browser__run_script");
  });

  test("does not expose task-owned Browser tools to subagents", () => {
    const result = createLumeRuntimeTools({ ...baseInput(), threadType: "subagent" });

    expect(result.customTools.some((tool) => tool.name.startsWith("mcp__browser__"))).toBeFalse();
  });

  test("does not mark the Browser executor as a permanently visible core tool", () => {
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
