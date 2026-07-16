import { describe, expect, test } from "bun:test";
import {
  buildAgentSendStartLogData,
  buildAgentContentLogData,
  buildRuntimeAttemptLogData
} from "./agent-log-summary";
import { setLogDigestPolicy } from "../infra/log-digest";

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

  test("正文摘要限制预览并移除常见凭证", () => {
    setLogDigestPolicy({
      schemaVersion: 1,
      algorithm: "hmac-sha256",
      keyVersion: 4,
      scope: "install",
      key: Buffer.alloc(32, 5).toString("base64")
    });
    const summary = buildAgentContentLogData(
      "assistant",
      `token=top-secret Bearer abc.def.ghi sk-1234567890 ${"x".repeat(300)}`
    );
    expect(summary.role).toBe("assistant");
    expect(summary.contentLength).toBeGreaterThan(300);
    expect(summary.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.contentDigestAlgorithm).toBe("hmac-sha256");
    expect(summary.contentDigestKeyVersion).toBe(4);
    expect(summary.contentDigestScope).toBe("install");
    expect(String(summary.contentPreview)).not.toContain("top-secret");
    expect(String(summary.contentPreview)).not.toContain("sk-1234567890");
    expect(String(summary.contentPreview).length).toBeLessThanOrEqual(259);
  });
});
