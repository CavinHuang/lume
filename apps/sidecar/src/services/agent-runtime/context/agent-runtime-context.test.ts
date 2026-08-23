import { registerRealAgentStores } from "../agent-thread-store-test-adapter";
registerRealAgentStores();
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentThread } from "../../agent/agent-thread-manager";
import { resolveAgentDynamicContextInput } from "./agent-runtime-context";

describe("agent-runtime-context", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-runtime-context-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("应从 session meta 组装 dynamic context 输入", () => {
    const meta = createAgentThread("Runtime Context Title", "channel-a", "workspace-a", "parent-a", "model-a");
    const result = resolveAgentDynamicContextInput({
      threadId: meta.id,
      userMessage: "help me",
      workspaceName: "Workspace Name",
      workspaceSlug: "workspace-slug",
      agentCwd: "D:/workspace/projects/ai-projects/lume",
      availableTools: ["Skill", "read"],
      threadType: "main",
      chatType: "direct",
      fallbackModelId: "fallback-model"
    });

    expect(result).toMatchObject({
      sessionId: meta.id,
      sessionTitle: "Runtime Context Title",
      parentSessionId: "parent-a",
      workspaceId: "workspace-a",
      channelId: "channel-a",
      modelId: "model-a",
      workspaceName: "Workspace Name",
      workspaceSlug: "workspace-slug",
      agentCwd: "D:/workspace/projects/ai-projects/lume"
    });
  });
});
