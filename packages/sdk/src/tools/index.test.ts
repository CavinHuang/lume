import { describe, expect, test } from "bun:test";
import { getAllBaseTools } from "./index.js";

describe("SDK tool registry", () => {
  test("does not expose legacy plan mode state tools", () => {
    const names = getAllBaseTools().map((tool) => tool.name);

    expect(names).not.toContain("EnterPlanMode");
    expect(names).not.toContain("ExitPlanMode");
  });
});
