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

  test("includes built-in node_repl tools for runtime threads", () => {
    const result = createLumeRuntimeTools({ ...baseInput(), workspaceSlug: "workspace-1" });
    const toolNames = result.customTools.map((tool) => tool.name);

    expect(toolNames).toContain("js");
    expect(toolNames).toContain("js_reset");
    expect(toolNames).toContain("js_add_node_module_dir");
    expect(result.availableToolNames).toContain("js");
    expect(result.availableToolNames).toContain("js_reset");
    expect(result.availableToolNames).toContain("js_add_node_module_dir");
  });
});
