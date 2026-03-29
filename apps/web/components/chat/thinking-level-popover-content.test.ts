import { describe, expect, test } from "bun:test";
import { THINKING_LEVEL_OPTIONS } from "./thinking-level";

describe("thinking-level-popover-content", () => {
  test("思考等级选项应覆盖五个等级且文案完整", () => {
    expect(THINKING_LEVEL_OPTIONS.map((item) => item.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max"
    ]);
    expect(THINKING_LEVEL_OPTIONS.every((item) => item.label.length > 0)).toBeTrue();
    expect(THINKING_LEVEL_OPTIONS.every((item) => item.description.length > 0)).toBeTrue();
  });
});
