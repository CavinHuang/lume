import { describe, expect, test } from "bun:test";
import { createLumeRuntimeTools } from "./create-lume-tools";

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
    expect(result.availableToolNames).toContain("send_im_message");
  });

  test("includes Alice-style WeRead reading workflow tools", () => {
    const result = createLumeRuntimeTools(baseInput());
    const toolNames = result.customTools.map((tool) => tool.name);

    expect(toolNames).toContain("weread_generate_note");
    expect(toolNames).toContain("weread_export_all_notes");
    expect(result.availableToolNames).toContain("weread_generate_note");
    expect(result.availableToolNames).toContain("weread_export_all_notes");
  });

  test("includes built-in node_repl tools as MCP-wrapped runtime tools", () => {
    const result = createLumeRuntimeTools({ ...baseInput(), workspaceSlug: "workspace-1" });
    const toolNames = result.customTools.map((tool) => tool.name);

    expect(toolNames).toContain("mcp__node_repl__js");
    expect(toolNames).toContain("mcp__node_repl__js_reset");
    expect(toolNames).toContain("mcp__node_repl__js_add_node_module_dir");
    expect(result.availableToolNames).toContain("mcp__node_repl__js");
    expect(result.availableToolNames).toContain("mcp__node_repl__js_reset");
    expect(result.availableToolNames).toContain("mcp__node_repl__js_add_node_module_dir");
    expect(toolNames).not.toContain("js");
  });

  test("includes built-in computer-use tools with MCP-compatible names", () => {
    const result = createLumeRuntimeTools(baseInput());
    const toolNames = result.customTools.map((tool) => tool.name);

    for (const name of [
      "list_apps",
      "list_windows",
      "get_window",
      "get_window_state",
      "launch_app",
      "activate_window",
      "move_pointer",
      "click",
      "press_key",
      "type_text",
      "scroll",
      "set_value",
      "drag",
      "perform_secondary_action",
      "current_context",
      "search_context",
      "wait_for_state",
    ]) {
      expect(toolNames).toContain(`mcp__computer_use__${name}`);
      expect(result.availableToolNames).toContain(`mcp__computer_use__${name}`);
    }
  });
});
