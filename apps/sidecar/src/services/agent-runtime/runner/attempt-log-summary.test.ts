import { describe, expect, test } from "bun:test";
import { buildRuntimeAttemptLogData } from "./attempt-log-summary";

describe("attempt-log-summary", () => {
  test("应生成 runtime 尝试阶段的关键日志字段", () => {
    const summary = buildRuntimeAttemptLogData({
      sessionId: "935b7a05-54eb-4fcf-ba65-bde7df8ac3f1",
      workspaceSlug: "default",
      provider: "zai",
      modelId: "glm-5.1",
      resume: true,
      permissionMode: "bypassPermissions",
      cwd: "/Users/demo/.lume/workspaces/default/thread-1",
      toolCount: 14
    });

    expect(summary).toEqual({
      sessionId: "935b7a05",
      workspaceSlug: "default",
      provider: "zai",
      modelId: "glm-5.1",
      resume: true,
      permissionMode: "bypassPermissions",
      cwd: "/Users/demo/.lume/workspaces/default/thread-1",
      toolCount: 14
    });
  });
});
