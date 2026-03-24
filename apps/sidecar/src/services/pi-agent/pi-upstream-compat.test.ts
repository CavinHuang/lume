import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionManager,
  createAgentSession,
  createReadOnlyTools
} from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";

describe("pi upstream compat", () => {
  test("应暴露 createAgentSession 与 SessionManager.inMemory", () => {
    expect(typeof createAgentSession).toBe("function");
    expect(typeof SessionManager.create).toBe("function");
    expect(typeof SessionManager.inMemory).toBe("function");
  });

  test("SessionManager.inMemory 应支持最小上下文构建", () => {
    const sessionManager = SessionManager.inMemory("E:/tmp/lume-upstream");

    sessionManager.appendModelChange("anthropic", "claude-sonnet-4-5");
    sessionManager.appendThinkingLevelChange("medium");
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now()
    });

    const context = sessionManager.buildSessionContext();
    expect(context.messages.length).toBe(1);
    expect(context.model).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5"
    });
    expect(context.thinkingLevel).toBe("medium");
  });

  test("createAgentSession 应可基于显式 model + inMemory session 启动最小会话", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-pi-upstream-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });

    const sessionManager = SessionManager.inMemory(cwd);
    const model = getModels("anthropic")[0];
    if (!model) {
      throw new Error("expected built-in anthropic models");
    }

    const result = await createAgentSession({
      cwd,
      agentDir,
      model,
      sessionManager,
      tools: createReadOnlyTools(cwd)
    });

    expect(result.session.sessionManager).toBe(sessionManager);
    expect(result.session.sessionId).toBe(sessionManager.getSessionId());
    expect(result.session.model?.provider).toBe(model.provider);
    expect(result.session.getActiveToolNames().length).toBeGreaterThan(0);

    const entries = sessionManager.getEntries();
    expect(entries.some((entry) => entry.type === "model_change")).toBeTrue();
    expect(entries.some((entry) => entry.type === "thinking_level_change")).toBeTrue();

    result.session.dispose();
  });
});
