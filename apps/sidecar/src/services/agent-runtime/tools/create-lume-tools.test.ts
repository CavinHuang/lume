import { describe, expect, test } from "bun:test";
import { createLumeRuntimeTools, createOrdinaryWikiTools, createWikiToolsForTrustedProfile } from "./create-lume-tools";
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
  test("keeps all Wiki schemas visible while a missing security gate blocks proposal execution", async () => {
    const tools = createOrdinaryWikiTools({
      profile: { scope: { kind: "workspace", workspaceId: "workspace-1" }, explicit: false },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["wiki.search", "wiki.read", "wiki.follow_links", "wiki.propose_changes"]);
    const proposal = tools.find((tool) => tool.name === "wiki.propose_changes")!;
    const result = await proposal.call({ action: "create", title: "不应创建" }, {} as never);
    expect(result.is_error).toBeTrue();
    expect(result.content).toContain("写入安全通道尚未就绪");
  });

  test("allows a proposal to reach staging while formal writes remain confirmation-gated", async () => {
    const tools = createOrdinaryWikiTools({
      profile: { scope: { kind: "workspace", workspaceId: "workspace-1" }, explicit: false },
      proposalEnabled: true,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["wiki.search", "wiki.read", "wiki.follow_links", "wiki.propose_changes"]);
    const proposal = tools.find((tool) => tool.name === "wiki.propose_changes");
    expect(proposal?.description).toContain("待用户确认");
    expect(proposal?.runtimeMetadata).toMatchObject({
      category: "control",
      capability: "planning",
      sideEffects: "local_write",
      allowedInPlanMode: true,
      isReadOnly: false
    });
    const authorizedResult = await proposal!.call({ action: "not-valid" }, {} as never);
    expect(authorizedResult.is_error).toBeTrue();
    expect(authorizedResult.content).toContain("action 必须是");
  });

  test("always exposes scoped reads in a dedicated Ask Wiki thread", () => {
    const tools = createWikiToolsForTrustedProfile({
      profile: { scope: { kind: "all" }, explicit: true },
      proposalEnabled: true,
      creatorThreadId: "ask-wiki-thread",
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "wiki.search",
      "wiki.read",
      "wiki.follow_links",
      "wiki.propose_changes"
    ]);
  });

  test("keeps the write schema usable without keyword-based intent gating", async () => {
    const tools = createOrdinaryWikiTools({
      profile: { scope: { kind: "workspace", workspaceId: "workspace-1" }, explicit: false },
      proposalEnabled: true,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["wiki.search", "wiki.read", "wiki.follow_links", "wiki.propose_changes"]);
    const proposal = tools.find((tool) => tool.name === "wiki.propose_changes");
    expect(proposal).toBeDefined();
    const result = await proposal!.call({ action: "not-valid" }, {} as never);
    expect(result.is_error).toBeTrue();
    expect(result.content).toContain("action 必须是");
  });

  test("keeps Wiki reads and proposal staging visible in plan mode", () => {
    const tools = createOrdinaryWikiTools({
      profile: { scope: { kind: "workspace", workspaceId: "workspace-1" }, explicit: false },
      proposalEnabled: true,
    });
    const registry = new ToolRegistry();
    registry.registerMany(createToolDescriptorsFromDefinitions(tools, "lume"));

    const resolved = new ToolResolver(registry).resolve({ permissionMode: "plan" });

    expect(resolved.map((tool) => tool.name)).toEqual([
      "wiki.search",
      "wiki.read",
      "wiki.follow_links",
      "wiki.propose_changes"
    ]);
    expect(resolved.find((tool) => tool.name === "wiki.propose_changes")?.metadata).toMatchObject({
      sideEffects: "local_write",
      allowedInPlanMode: true,
      isReadOnly: false
    });
  });

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
      "click",
      "press_key",
      "type_text",
      "scroll",
      "set_value",
      "drag",
      "perform_secondary_action",
    ]) {
      expect(toolNames).toContain(`mcp__computer_use__${name}`);
      expect(result.availableToolNames).toContain(`mcp__computer_use__${name}`);
    }
    for (const removed of ["take_screenshot", "move_pointer", "current_context", "search_context", "wait_for_state"] ) {
      expect(toolNames).not.toContain(`mcp__computer_use__${removed}`);
    }
  });

  test("exposes only node_repl for the sky Computer Use surface", () => {
    const result = createLumeRuntimeTools({ ...baseInput(), computerUseSurface: "sky" });
    const toolNames = result.customTools.map((tool) => tool.name);

    expect(toolNames).toContain("mcp__node_repl__js");
    expect(toolNames).not.toContain("mcp__node_repl__js_reset");
    expect(toolNames).not.toContain("mcp__node_repl__js_add_node_module_dir");
    expect(toolNames.some((name) => name.startsWith("mcp__computer_use__"))).toBeFalse();
    expect(result.availableToolNames.some((name) => name.startsWith("mcp__computer_use__"))).toBeFalse();
  });
});
