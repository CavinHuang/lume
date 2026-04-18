import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AskUserQuestionTool } from "@lume/agent-sdk";
import type { Model } from "../runner/model-types";
import { buildSidecarSubagentRunContext, createRuntimeCoreSession } from "./run";
import { runRuntimeCoreAttempt } from "./attempt";
import { getRuntimeCoreSessionDir } from "./session-store";
import { getAgentSessionWorkspacePath, getAgentWorkspacePath } from "../../infra/config-paths";
import { createAgentThread } from "../../agent/agent-thread-manager";
import { createAgentWorkspace } from "../../agent/agent-workspace-manager";
import { createChannel } from "../../channel/channel-manager";

describe("runtime-core run", () => {
  const prevConfigDir = process.env.LUME_CONFIG_DIR;

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
  });

  test("应创建最小 upstream AgentSession PoC", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "test-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan"
    });

    expect(result.session.threadId).toBe(result.sessionManager.getSessionId());
    expect(result.session.model?.provider).toBe("anthropic");
    expect(result.session.getActiveToolNames().length).toBeGreaterThan(0);
    expect(result.session.getActiveToolNames()).toContain("ls");
    const init = await result.agent.getInitializationResult();
    expect(init.agents.map((agent) => agent.name)).toEqual([
      "explorer",
      "researcher",
      "code-reviewer"
    ]);

    result.session.dispose();
  });

  test("应优先暴露 SDK 原生基础工具名，而不是小写包装名", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-native-tools-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "native-tool-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "acceptEdits"
    });

    const toolNames = result.session.getActiveToolNames();
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Write");
    expect(toolNames).toContain("Edit");
    expect(toolNames).toContain("Bash");
    expect(toolNames).toContain("Glob");
    expect(toolNames).toContain("Grep");
    expect(toolNames).toContain("WebSearch");
    expect(toolNames).toContain("WebFetch");
    expect(toolNames).not.toContain("read");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("find");
    expect(toolNames).not.toContain("grep");
    expect(toolNames).not.toContain("web_search");
    expect(toolNames).not.toContain("web_fetch");

    result.session.dispose();
  });

  test("应直接注册 SDK 原生 AskUserQuestionTool，并在自动化执行时移除它", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-ask-user-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });

    const interactive = await createRuntimeCoreSession({
      lumeSessionId: "ask-user-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "acceptEdits"
    });
    expect(interactive.tools.some((tool) => tool === AskUserQuestionTool)).toBeTrue();
    interactive.session.dispose();

    const automation = await createRuntimeCoreSession({
      lumeSessionId: "ask-user-automation-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "acceptEdits",
      messageMetadata: {
        automationJobId: "job-1"
      }
    });
    expect(automation.tools.some((tool) => tool === AskUserQuestionTool)).toBeFalse();
    automation.session.dispose();
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
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan"
    });
    const firstUpstreamSessionId = first.session.threadId;
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
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan"
    });

    expect(second.sessionManager.buildSessionContext().messages.some((message) => message.role === "user")).toBeTrue();
    expect(second.session.messages.some((message) => message.role === "user")).toBeTrue();
    expect(second.session.threadId).toBe(firstUpstreamSessionId);
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
      resolvedModelId: "non-existent-catalog-model",
      resolvedModel,
      apiKey: "test-key",
      permissionMode: "plan"
    });

    expect(result.session.model?.id).toBe("custom-runtime-model");
    expect(result.session.model?.baseUrl).toBe("https://example.invalid/v1");
    result.session.dispose();
  });

  test("应将 Lume prompt builder 的系统提示和动态上下文注入 runtime session", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-config-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspaceSlug = "prompt-injection";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    writeFileSync(join(workspacePath, "AGENTS.md"), "# Workspace Rules\n- Always verify edits before final output.", "utf-8");
    writeFileSync(join(workspacePath, "SOUL.md"), "# Persona\n- Be sharp, calm, and warm.", "utf-8");

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-prompt-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "prompt-session",
      cwd,
      agentDir,
      userMessage: "help me create an execution plan",
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      workspaceName: "Prompt Injection Workspace",
      workspaceSlug,
      threadType: "main",
      chatType: "direct"
    });

    const systemPrompt = result.session.agent.state.systemPrompt;
    expect(systemPrompt).toContain("You are Lume, a persistent counterpart running inside this workspace.");
    expect(systemPrompt).toContain("## Workspace Files (injected)");
    expect(systemPrompt).toContain("## 系统配置");
    expect(systemPrompt).toContain("~/.lume/lume.yaml");
    expect(systemPrompt).not.toContain(".lume-config");
    expect(systemPrompt).toContain("## Project Context");
    expect(systemPrompt).toContain("## AGENTS.md");
    expect(systemPrompt).toContain("Always verify edits before final output.");
    expect(systemPrompt).toContain("- Skill");
    expect(systemPrompt).toContain("<thread_state>");
    expect(systemPrompt).toContain("threadType: main");
    expect(systemPrompt).toContain("chatType: direct");
    expect(systemPrompt).toContain("modelId: claude-sonnet-4-5");
    expect(systemPrompt).toContain("Preferred capability route: skills");
    expect(systemPrompt).toContain("<working_directory>");

    result.session.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("runRuntimeCoreAttempt 不应在工作区线程目录创建 .lume-config 映射", async () => {
    const prevMockSuccess = process.env.LUME_PI_AGENT_MOCK_SUCCESS;
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-attempt-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    process.env.LUME_PI_AGENT_MOCK_SUCCESS = "1";

    const workspace = createAgentWorkspace("No Mirror Workspace");
    const channel = createChannel({
      name: "mock-openai",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      enabled: true,
      defaultModelId: "gpt-5.4-mini",
      models: [
        {
          id: "gpt-5.4-mini",
          name: "gpt-5.4-mini",
          provider: "openai"
        }
      ]
    });

    const thread = createAgentThread("runtime attempt no mirror", channel.id, workspace.id, undefined, "gpt-5.4-mini");
    const sessionId = thread.id;
    const threadDir = getAgentSessionWorkspacePath(workspace.slug, sessionId);

    const result = await runRuntimeCoreAttempt(
      {
        input: {
          userMessage: "hello",
          permissionMode: "plan",
          chatType: "direct"
        },
        runtime: {
          sessionId,
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
        onToolPermissionRequest: () => {}
      },
      {
        registerAbort: () => {},
        unregisterAbort: () => {}
      }
    );

    expect(result.status).toBe("completed");
    expect(existsSync(join(threadDir, ".lume-config"))).toBeFalse();

    if (prevMockSuccess === undefined) {
      delete process.env.LUME_PI_AGENT_MOCK_SUCCESS;
    } else {
      process.env.LUME_PI_AGENT_MOCK_SUCCESS = prevMockSuccess;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  test("Lume runtime 应把 workspace skills 真正注册到 SDK", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-skills-config-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspaceSlug = "runtime-skill-registration";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const skillDir = join(workspacePath, "skills", "planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: planner",
        "description: planning skill",
        "---",
        "# Planner",
        "",
        "Use this skill for structured planning.",
      ].join("\n"),
      "utf-8"
    );

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-skills-"));
    const agentDir = join(cwd, ".pi-agent-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "skill-runtime-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      workspaceSlug,
      workspaceName: "Runtime Skills Workspace"
    });

    const init = await result.agent.getInitializationResult();
    expect(init.skills).toContain("planner");

    result.session.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("buildSidecarSubagentRunContext 应统一 registry 与 SDK 使用的 subagent_run_id", () => {
    const result = buildSidecarSubagentRunContext({
      parentThreadId: "parent-thread",
      toolInput: {
        prompt: "执行子任务",
        description: "测试子任务",
        subagent_type: "explorer"
      },
      policy: {
        depth: 2,
        rootThreadId: "root-thread",
        parentRunId: "parent-run"
      },
      createRunId: () => "run-fixed",
      createChildThreadId: () => "child-fixed"
    });

    expect(result.runId).toBe("run-fixed");
    expect(result.childThreadId).toBe("child-fixed");
    expect(result.forwardedToolInput.subagent_run_id).toBe("run-fixed");
    expect(result.registryInput.runId).toBe("run-fixed");
    expect(result.registryInput.childThreadId).toBe("child-fixed");
    expect(result.registryInput.parentThreadId).toBe("parent-thread");
    expect(result.registryInput.rootThreadId).toBe("root-thread");
    expect(result.registryInput.parentRunId).toBe("parent-run");
  });
});
