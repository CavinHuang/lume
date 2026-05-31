import { describe, expect, test } from "bun:test";
import { getAllBaseTools } from "./index.js";

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

  test("exposes Guanlan as dedicated built-in web tools", () => {
    const names = getAllBaseTools().map((tool) => tool.name);

    expect(names).toContain("guanlan_search");
    expect(names).toContain("guanlan_read");
    expect(names).toContain("guanlan_hotnews");
    expect(names).toContain("guanlan_research");
  });
});
