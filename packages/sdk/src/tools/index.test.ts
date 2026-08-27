import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../types";
import { filterTools, getAllBaseTools } from "./index.js";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    call: async () => ({ type: "tool_result", tool_use_id: "", content: name }),
  };
}

describe("SDK tool registry", () => {
  test("does not expose legacy plan mode state tools", () => {
    const names = getAllBaseTools().map((tool) => tool.name);

    expect(names).not.toContain("EnterPlanMode");
    expect(names).not.toContain("ExitPlanMode");
  });

  test("does not expose in-memory automation task stubs", () => {
    const names = getAllBaseTools().map((tool) => tool.name);

    expect(names).not.toContain("automation_create");
    expect(names).not.toContain("automation_list");
    expect(names).not.toContain("automation_update");
    expect(names).not.toContain("automation_delete");
    expect(names).not.toContain("automation_run_now");
  });

  // #720 review 钉：MultiEdit 是写原语，注册面四处（工具池/CORE/权限面/tracker）
  // 任一漏接都会造成静默旁路（dontAsk 免审/partial-read 覆写/writer lease）。
  test("MultiEdit is registered in the base pool and core preset", () => {
    const names = getAllBaseTools().map((tool) => tool.name);
    expect(names).toContain("MultiEdit");

    const multiEdit = getAllBaseTools().find((tool) => tool.name === "MultiEdit")!;
    expect(multiEdit.isReadOnly()).toBe(false);
    expect(multiEdit.isConcurrencySafe()).toBe(false);
  });

  test("filterTools accepts Alice-style allowed and disallowed aliases", () => {
    const tools = [tool("Read"), tool("Bash"), tool("Write")];

    expect(filterTools(tools, ["read_file", "bash"]).map((item) => item.name)).toEqual([
      "Read",
      "Bash",
    ]);
    expect(filterTools(tools, undefined, ["write_file"]).map((item) => item.name)).toEqual([
      "Read",
      "Bash",
    ]);
  });
});
