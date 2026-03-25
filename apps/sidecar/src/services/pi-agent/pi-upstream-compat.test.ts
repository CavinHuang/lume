import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  createReadOnlyTools
} from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";

describe("pi upstream compat", () => {
  test("应暴露 Lume 运行时依赖的上游构造器与工厂", () => {
    expect(typeof createAgentSession).toBe("function");
    expect(typeof SessionManager.create).toBe("function");
    expect(typeof SessionManager.inMemory).toBe("function");
    expect(typeof SessionManager.continueRecent).toBe("function");
    expect(typeof AuthStorage).toBe("function");
    expect(typeof ModelRegistry).toBe("function");
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

  test("SessionManager.continueRecent 应暴露 Lume 使用的 transcript manager 能力", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-pi-upstream-continue-"));
    const sessionDir = join(cwd, ".pi-session");
    const created = SessionManager.continueRecent(cwd, sessionDir);

    created.appendModelChange("anthropic", "claude-sonnet-4-5");
    created.appendThinkingLevelChange("medium");
    const leafId = created.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello continue recent" }],
      timestamp: Date.now()
    });
    created.appendCompaction("summary", leafId, 0, { source: "compat-test" });

    expect(created.getSessionDir()).toBe(sessionDir);
    expect(existsSync(sessionDir)).toBeTrue();
    expect(created.getSessionFile()).toBeDefined();
    expect(created.getEntries().some((entry) => entry.type === "compaction")).toBeTrue();
    expect(typeof created.buildSessionContext).toBe("function");
  });

  test("AuthStorage + ModelRegistry 应支持 runtime-core 的显式文件路径模式", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lume-pi-upstream-model-registry-"));
    const authPath = join(agentDir, "auth.json");
    const modelsPath = join(agentDir, "models.json");

    const authStorage = new AuthStorage(authPath);
    const modelRegistry = new ModelRegistry(authStorage, modelsPath);
    modelRegistry.registerProvider("anthropic", { apiKey: "sk-test" });

    expect(existsSync(agentDir)).toBeTrue();
    expect(typeof modelRegistry.registerProvider).toBe("function");
    expect(typeof modelRegistry.getAvailable).toBe("function");
    expect(typeof modelRegistry.getAll).toBe("function");
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
