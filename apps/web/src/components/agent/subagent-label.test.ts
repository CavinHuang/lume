import { describe, expect, test } from "bun:test";
import { getSubagentDisplayLabel } from "./subagent-label";

describe("getSubagentDisplayLabel", () => {
  test("应优先显示 subagentLabel", () => {
    expect(getSubagentDisplayLabel({
      subagentLabel: "探索工具能力边界",
      subagentRunId: "run-1"
    })).toBe("探索工具能力边界");
  });

  test("缺少 subagentLabel 时退回 run id", () => {
    expect(getSubagentDisplayLabel({
      subagentRunId: "run-1"
    })).toBe("Subagent run-1");
  });
});
