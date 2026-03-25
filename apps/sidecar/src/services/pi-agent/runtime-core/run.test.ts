import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Model } from "@mariozechner/pi-ai";
import { createRuntimeCoreSession } from "./run";
import { getRuntimeCoreSessionDir } from "./session-store";

describe("runtime-core run", () => {
  test("应创建最小 upstream AgentSession PoC", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "test-session",
      cwd,
      agentDir,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan"
    });

    expect(result.session.sessionId).toBe(result.sessionManager.getSessionId());
    expect(result.session.model?.provider).toBe("anthropic");
    expect(result.session.getActiveToolNames().length).toBeGreaterThan(0);
    expect(result.session.getActiveToolNames()).toContain("sessions_list");

    result.session.dispose();
  });

  test("应为同一个 Lume session 使用稳定 transcript 目录", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-stable-dir-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });
    const first = getRuntimeCoreSessionDir("agent:main:test", agentDir);
    const second = getRuntimeCoreSessionDir("agent:main:test", agentDir);
    expect(first).toBe(second);
  });

  test("同一个 Lume session 应恢复既有 transcript", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-restore-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });
    const sessionDir = getRuntimeCoreSessionDir("restore-session", agentDir);

    const first = await createRuntimeCoreSession({
      lumeSessionId: "restore-session",
      cwd,
      agentDir,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan"
    });
    const firstUpstreamSessionId = first.session.sessionId;
    first.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "restore me" }],
      timestamp: Date.now()
    });
    first.sessionManager.appendMessage({
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: "restored answer" }],
      timestamp: Date.now()
    });
    expect(existsSync(sessionDir)).toBeTrue();
    expect(readdirSync(sessionDir).some((file) => file.endsWith(".jsonl"))).toBeTrue();
    expect(first.sessionManager.buildSessionContext().messages.some((message) => message.role === "user")).toBeTrue();
    first.session.dispose();

    const second = await createRuntimeCoreSession({
      lumeSessionId: "restore-session",
      cwd,
      agentDir,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan"
    });

    expect(second.sessionManager.buildSessionContext().messages.some((message) => message.role === "user")).toBeTrue();
    expect(second.session.messages.some((message) => message.role === "user")).toBeTrue();
    expect(second.session.sessionId).toBe(firstUpstreamSessionId);
    second.session.dispose();
  });

  test("应接受显式 resolvedModel，避免重新回退到 catalog 查询", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-explicit-model-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });

    const resolvedModel: Model<"openai-responses"> = {
      id: "custom-runtime-model",
      name: "custom-runtime-model",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://example.invalid/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 32768
    };

    const result = await createRuntimeCoreSession({
      lumeSessionId: "explicit-model-session",
      cwd,
      agentDir,
      provider: "openai",
      modelId: "non-existent-catalog-model",
      resolvedModel,
      apiKey: "test-key",
      permissionMode: "plan"
    });

    expect(result.session.model?.id).toBe("custom-runtime-model");
    expect(result.session.model?.baseUrl).toBe("https://example.invalid/v1");
    result.session.dispose();
  });
});
