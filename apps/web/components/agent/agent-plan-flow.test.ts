import { describe, expect, test } from "bun:test";
import { resolveRestoredPermissionMode } from "./agent-plan-flow";

describe("agent-plan-flow", () => {
  test("review 阶段恢复时，非 plan 模式应原样恢复", () => {
    expect(resolveRestoredPermissionMode("default")).toBe("default");
    expect(resolveRestoredPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(resolveRestoredPermissionMode("bypassPermissions")).toBe("bypassPermissions");
  });

  test("如果 lastNonPlanPermissionMode 意外为 plan，应回退到 default", () => {
    expect(resolveRestoredPermissionMode("plan")).toBe("default");
  });
});
