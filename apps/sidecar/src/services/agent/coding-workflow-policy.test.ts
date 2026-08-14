import { describe, expect, test } from "bun:test";
import { shouldTrackCodingWorkflow } from "./coding-workflow-policy";

describe("coding workflow policy", () => {
  test("keeps coding bookkeeping for direct implementation requests", () => {
    expect(shouldTrackCodingWorkflow("开始修复这个 TypeScript bug")).toBeTrue();
  });

  test("does not turn a browser request into a coding workflow", () => {
    expect(shouldTrackCodingWorkflow("打开我的 X，看看最新的 10 条 post")).toBeFalse();
  });
});
