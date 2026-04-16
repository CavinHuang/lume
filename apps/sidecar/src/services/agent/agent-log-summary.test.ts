import { describe, expect, test } from "bun:test";
import {
  buildAgentSendStartLogData,
  buildRuntimeAttemptLogData
} from "./agent-log-summary";

describe("agent-log-summary", () => {
  test("应生成发送阶段的关键日志字段", () => {
    const summary = buildAgentSendStartLogData({
      threadId: "2f9763fa-d507-433e-914e-c3a0043d7b0f",
      workspaceId: "workspace-1",
      channelId: "channel-1",
      modelId: "glm-5.1",
      modelRef: "zai/glm-5.1",
      appendUserMessage: true,
      preferredCapabilityRoute: "skills",
      capabilityLanes: ["skills", "tools"],
      userMessage: "请帮我自我介绍，并保持简洁"
    });

    expect(summary).toEqual({
      threadId: "2f9763fa",
      workspaceId: "workspace-1",
      channelId: "channel-1",
      modelId: "glm-5.1",
      modelRef: "zai/glm-5.1",
      appendUserMessage: true,
      preferredCapabilityRoute: "skills",
      capabilityLanes: ["skills", "tools"],
      userMessagePreview: "请帮我自我介绍，并保持简洁"
    });
  });

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
