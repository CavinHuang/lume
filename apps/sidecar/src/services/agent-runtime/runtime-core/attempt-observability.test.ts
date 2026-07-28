import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentThread } from "../../agent/agent-thread-manager";
import { createAgentWorkspace } from "../../agent/agent-workspace-manager";
import { createChannel } from "../../channel/channel-manager";
import { getAgentSessionWorkspacePath } from "../../infra/config-paths";
import { getRuntimeCoreSessionDir } from "./session-store";
import { runRuntimeCoreAttempt } from "./attempt";

describe("runtime-core attempt observability", () => {
  const prevConfigDir = process.env.LUME_CONFIG_DIR;
  const prevMockSuccess = process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS;

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (prevMockSuccess === undefined) {
      delete process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS;
    } else {
      process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS = prevMockSuccess;
    }
  });

  test("records run state and trace files without changing runtime output", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-attempt-observability-"));
    const projectDir = join(configDir, "project");
    mkdirSync(projectDir);
    process.env.LUME_CONFIG_DIR = configDir;
    process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS = "1";

    const workspace = createAgentWorkspace("Observability Workspace", { projectPath: projectDir });
    const channel = createChannel({
      name: "mock-observability",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      enabled: true,
      defaultModelId: "gpt-5.4-mini",
      models: [{ id: "gpt-5.4-mini", name: "gpt-5.4-mini", enabled: true }]
    });
    const thread = createAgentThread("runtime observability", channel.id, workspace.id, undefined, "gpt-5.4-mini");

    const result = await runRuntimeCoreAttempt(
      {
        input: {
          threadId: thread.id,
          userMessage: "hello",
          permissionMode: "plan",
          chatType: "direct"
        },
        runtime: {
          sessionId: thread.id,
          channelId: channel.id,
          resolvedModelId: "gpt-5.4-mini",
          workspaceId: workspace.id,
          threadType: "main"
        }
      },
      {
        onSdkMessage: () => {},
        onComplete: () => {},
        onError: () => {},
        onAskUserQuestion: () => {},
        onBrowserAuthRequest: () => {},
        onToolPermissionRequest: () => {}
      },
      {
        registerAbort: () => {},
        unregisterAbort: () => {}
      }
    );

    expect(result).toEqual({ status: "completed" });
    const sessionDir = getRuntimeCoreSessionDir(thread.id);
    const runFiles = readdirSync(join(sessionDir, "runs"));
    const traceFiles = readdirSync(join(sessionDir, "traces"));
    expect(runFiles.some((file) => file.endsWith(".json"))).toBeTrue();
    expect(runFiles.some((file) => file.endsWith(".items.jsonl"))).toBeTrue();
    expect(traceFiles.some((file) => file.endsWith(".json"))).toBeTrue();
    expect(existsSync(join(sessionDir, "runtime-state.json"))).toBeTrue();
    expect(existsSync(join(getAgentSessionWorkspacePath(workspace.slug, thread.id), "systemPrompt.md"))).toBeFalse();

    rmSync(configDir, { recursive: true, force: true });
  });
});
