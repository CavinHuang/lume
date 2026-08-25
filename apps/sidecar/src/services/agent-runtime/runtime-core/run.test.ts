import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AskUserQuestionTool } from "@lume/agent-sdk";
import type { ToolContext, ToolDefinition } from "@lume/agent-sdk";
import type { Model } from "./model-types";
import type { LumeRunState } from "./run-state";
import { createFileBackedLumeRunStateStore } from "./run-state-store";
import { createRuntimeCoreSession, type CreateRuntimeCoreSessionInput } from "./run";
import {
  buildSidecarSubagentExecutionInput,
  buildSidecarSubagentRunContext,
  resolveForegroundSubagentTimeoutMs,
  resolveSubagentModelOverride,
  runForegroundSubagentWithTimeout
} from "./run-subagent";
import { resolvePromptCachePolicy } from "./request-policy";
import { runRuntimeCoreAttempt } from "../runner/attempt";
import { prepareRuntimeCoreAttempt } from "../runner/prepare-attempt";
import { getRuntimeCoreSessionDir } from "./session-store";
import { getAgentSessionWorkspacePath, getAgentWorkspacePath, getAliceUserSkillsDir, getDefaultSkillsDir } from "../../infra/config-paths";
import { createAgentThread } from "../../agent/agent-thread-manager";
import { createAgentWorkspace } from "../../agent/agent-workspace-manager";
import { getSubagentRunRegistry, resetSubagentRunRegistryForTest } from "../subagents/subagent-run-registry";
import { createChannel } from "../../channel/channel-manager";
import { installConnectionVaultKey } from "../../channel/connection-credential-store";
import { updateLumeConfigSection } from "../../system/lume-config-service";
import { getRuntimeToolDescriptor } from "../tools/tool-descriptor-session";
import { evaluatePluginSensitiveGate } from "../plugins/sensitive-gate.js";
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import { FilePluginStateStore } from "../plugins/plugin-state-store.js";
import {
  setWorkspaceMcpManagerForTesting,
  type WorkspaceMcpManager
} from "../../mcp/workspace-mcp-manager";

function availableTools(result: Awaited<ReturnType<typeof createRuntimeCoreSession>>): ToolDefinition[] {
  const deferred = (result.agent as unknown as { deferredToolPool?: ToolDefinition[] }).deferredToolPool ?? [];
  return [...result.tools, ...deferred];
}

function availableToolNames(result: Awaited<ReturnType<typeof createRuntimeCoreSession>>): string[] {
  return availableTools(result).map((tool) => tool.name);
}

describe("runtime-core run", () => {
  const prevConfigDir = process.env.LUME_CONFIG_DIR;
  const prevAliceConfigDir = process.env.ALICE_CONFIG_DIR;

  beforeEach(() => {
    installConnectionVaultKey(Buffer.alloc(32, 23).toString("base64"));
  });

  function createHookRuntimeSessionInput(
    overrides: Partial<CreateRuntimeCoreSessionInput> = {}
  ): CreateRuntimeCoreSessionInput {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-hooks-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });
    return {
      lumeSessionId: "test-session-hooks",
      cwd,
      agentDir,
      userMessage: "hello",
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      ...overrides
    };
  }

  afterEach(() => {
    setWorkspaceMcpManagerForTesting(null);
    resetSubagentRunRegistryForTest();
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (prevAliceConfigDir === undefined) {
      delete process.env.ALICE_CONFIG_DIR;
    } else {
      process.env.ALICE_CONFIG_DIR = prevAliceConfigDir;
    }
  });

  test("应创建最小 upstream AgentSession PoC", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-"));
    const agentDir = join(cwd, ".runtime-core-test");
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
    expect(result.session.getActiveToolNames()).toContain("Read");
    expect(result.session.getActiveToolNames()).not.toContain("ls");
    expect(result.session.getActiveToolNames()).toContain("AskUserQuestion");
    expect(result.session.getActiveToolNames()).toContain("TaskList");
    expect(result.session.getActiveToolNames()).toContain("TaskGet");
    expect(result.session.getActiveToolNames()).not.toContain("TaskReport");
    expect(result.session.getActiveToolNames()).not.toContain("Write");
    expect(result.session.getActiveToolNames()).not.toContain("Bash");
    const init = await result.agent.getInitializationResult();
    expect(init.agents.map((agent) => agent.name)).toEqual([
      "explorer",
      "planner",
      "researcher",
      "code-reviewer",
      "translator",
      "writer",
      "voice",
      "designer",
      "artist",
      "analyst",
      "quant",
      "novelist",
      "developer"
    ]);

    result.session.dispose();
  });

  test("后台子会话终态结果只在原运行内合并续跑一次", async () => {
    const lumeSessionId = `background-completion-${crypto.randomUUID()}`;
    const runId = `run-${crypto.randomUUID()}`;
    const registry = getSubagentRunRegistry();
    registry.create({
      runId: "background-child",
      parentThreadId: lumeSessionId,
      parentRunId: runId,
      rootThreadId: lumeSessionId,
      depth: 1,
      childThreadId: "background-child-thread",
      task: "inspect",
      cleanup: "keep",
      status: "running",
      background: true
    });
    registry.update("background-child", {
      status: "completed",
      outcome: { output: "inspection complete" }
    });
    const result = await createRuntimeCoreSession(createHookRuntimeSessionInput({
      lumeSessionId,
      runId,
      permissionMode: "acceptEdits"
    }));
    // 真值透传钉子（#571 第 4 项）：cfg 层必须收到原值而非折叠后的 default
    expect((result.agent as any).baseOptions.permissionMode).toBe("acceptEdits");
    const completionGuard = (result.agent as any).baseOptions.completionGuard as () => Promise<unknown>;

    await expect(completionGuard()).resolves.toMatchObject({
      type: "continue",
      message: expect.stringContaining("<background-task-results>")
    });
    await expect(completionGuard()).resolves.toBeUndefined();
    await result.session.dispose();
  });

  test("延迟工具搜索注册 SDK 生成工具的 Runtime descriptor", async () => {
    const previousToolSearch = process.env.ENABLE_TOOL_SEARCH;
    process.env.ENABLE_TOOL_SEARCH = "tst";
    const sessionId = `tool-search-descriptor-${crypto.randomUUID()}`;
    let result: Awaited<ReturnType<typeof createRuntimeCoreSession>> | undefined;

    try {
      result = await createRuntimeCoreSession(createHookRuntimeSessionInput({
        lumeSessionId: sessionId,
        permissionMode: "default"
      }));
      await result.agent.getInitializationResult();

      const deferredTools = (result.agent as unknown as { deferredToolPool: ToolDefinition[] }).deferredToolPool;
      expect(deferredTools.length).toBeGreaterThan(0);
      expect(getRuntimeToolDescriptor(sessionId, deferredTools[0]!.name)).toBeDefined();
      expect(getRuntimeToolDescriptor(sessionId, "ToolSearch")).toBeDefined();
      expect(getRuntimeToolDescriptor(sessionId, "ExecuteTool")).toBeDefined();
    } finally {
      await result?.session.dispose();
      if (previousToolSearch === undefined) {
        delete process.env.ENABLE_TOOL_SEARCH;
      } else {
        process.env.ENABLE_TOOL_SEARCH = previousToolSearch;
      }
    }
  });

  test("Browser 执行器保持延迟可发现且不依赖预判路由", async () => {
    const previousToolSearch = process.env.ENABLE_TOOL_SEARCH;
    process.env.ENABLE_TOOL_SEARCH = "tst";
    let result: Awaited<ReturnType<typeof createRuntimeCoreSession>> | undefined;

    try {
      result = await createRuntimeCoreSession(createHookRuntimeSessionInput({
        lumeSessionId: `browser-tool-${crypto.randomUUID()}`,
        workspaceSlug: `browser-route-${crypto.randomUUID()}`,
        permissionMode: "default",
        userMessage: "打开百度搜索agent"
      }));
      await result.agent.getInitializationResult();

      expect(result.session.getActiveToolNames()).not.toContain("mcp__node_repl__js");
      expect(result.session.getActiveToolNames()).toContain("Bash");
      expect(result.runtimeContext).not.toContain("Preferred capability route:");
      // 固定浏览器策略文本已上移稳定 system prompt（prompt cache 可覆盖，不随回合重复进历史）
      expect(result.systemPrompt).toContain("mcp__browser__list_tabs");
      expect(result.systemPrompt).toContain("do not activate browser:browser");
      expect(result.runtimeContext).not.toContain("mcp__browser__list_tabs");
      const runtimeSkills = (result.agent as any).baseOptions.skills as Array<{ name: string }>;
      expect(runtimeSkills.map((skill) => skill.name)).not.toContain("browser:browser");
      const deferredTools = (result.agent as unknown as { deferredToolPool: ToolDefinition[] }).deferredToolPool;
      expect(deferredTools.map((tool) => tool.name)).toContain("mcp__node_repl__js");
    } finally {
      await result?.session.dispose();
      if (previousToolSearch === undefined) delete process.env.ENABLE_TOOL_SEARCH;
      else process.env.ENABLE_TOOL_SEARCH = previousToolSearch;
    }
  });

  test("主线程暴露 Delegate 委派工具，子会话不能继续派生", async () => {
    const parent = await createRuntimeCoreSession(createHookRuntimeSessionInput({ permissionMode: "default", runId: "parent-run" }));
    expect(parent.session.getActiveToolNames()).toContain("Delegate");
    expect(parent.session.getActiveToolNames()).toContain("WaitForDelegations");
    expect(parent.session.getActiveToolNames()).not.toContain("Agent");
    expect(parent.session.getActiveToolNames()).not.toContain("FinishAgentTask");
    expect(parent.session.getActiveToolNames()).not.toContain("RetireSubagent");
    // 并发标记钉住(#642):flag 与文案曾反复横跳,override 本体必须有护栏
    const delegateTool = parent.tools.find((tool) => tool.name === "Delegate");
    const waitTool = parent.tools.find((tool) => tool.name === "WaitForDelegations");
    expect(delegateTool?.isConcurrencySafe?.()).toBe(true);
    expect(waitTool?.isConcurrencySafe?.()).toBe(false);
    await parent.session.dispose();

    const child = await createRuntimeCoreSession(createHookRuntimeSessionInput({
      lumeSessionId: "subagent-session", threadType: "subagent", subagentType: "explorer", subagentRunId: "run-1", subagentId: "explorer-01"
    }));
    expect(child.session.getActiveToolNames()).not.toContain("Delegate");
    expect(child.session.getActiveToolNames()).not.toContain("Agent");
    for (const taskTool of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "TaskOutput", "ProcessOutput", "ProcessStop"]) {
      expect(child.session.getActiveToolNames()).not.toContain(taskTool);
    }
    await child.session.dispose();
  });

  test("executes context hooks around context assembly", async () => {
    const seen: string[] = [];
    const applied: string[] = [];
    const result = await createRuntimeCoreSession({
      ...createHookRuntimeSessionInput({
        runId: "run-hooks"
      }),
      workflowHooks: {
        execute: async (event) => {
          seen.push(event.event);
          if (event.event === "context.beforeAssemble") {
            return {
              effects: [{
                effect: {
                  type: "appendContext",
                  source: "hook:core-memory-recall",
                  content: "<lume_memory_context>\nremembered\n</lume_memory_context>",
                  hidden: true,
                  usedMemoryItems: [],
                  userMessageForModel: "<lume_memory_context>\nremembered\n</lume_memory_context>\n<user_message>\nhello\n</user_message>"
                },
                sourceContributionId: "core.memory.context",
                createdAt: "2026-05-26T00:00:00.000Z"
              }],
              errors: []
            };
          }
          expect(event).toMatchObject({
            event: "context.afterAssemble",
            availableTools: expect.any(Array),
            tokenBudget: expect.any(Number),
            userMessageForModelLength: expect.any(Number)
          });
          return {
            effects: [{
              effect: {
                type: "recordTrace",
                record: {
                  type: "workflow_hook",
                  contributionId: "core.observability.trace",
                  event: "context.afterAssemble",
                  status: "success"
                }
              },
              sourceContributionId: "core.observability.trace",
              createdAt: "2026-05-26T00:00:00.000Z"
            }],
            errors: []
          };
        }
      },
      applyWorkflowHookEffects: async (hookResult) => {
        applied.push(...hookResult.effects.map((item) => item.effect.type));
      }
    });

    expect(seen).toEqual(["context.beforeAssemble", "context.afterAssemble"]);
    expect(applied).toEqual(["recordTrace"]);
    expect(String(result.userMessageForModel)).toContain("remembered");

    await result.session.dispose();
  });

  test("continues context assembly when context hook throws", async () => {
    const result = await createRuntimeCoreSession({
      ...createHookRuntimeSessionInput(),
      workflowHooks: {
        execute: async () => {
          throw new Error("hook failed");
        }
      }
    });

    expect(result.userMessageForModel).toBeTruthy();

    await result.session.dispose();
  });

  test("continues context assembly when after hook reports errors and effect application throws", async () => {
    const result = await createRuntimeCoreSession({
      ...createHookRuntimeSessionInput(),
      workflowHooks: {
        execute: async (event) => event.event === "context.afterAssemble"
          ? {
              effects: [{
                effect: {
                  type: "recordTrace",
                  record: {
                    type: "workflow_hook",
                    contributionId: "core.observability.trace",
                    event: "context.afterAssemble",
                    status: "error",
                    errorMessage: "diagnostic failure"
                  }
                },
                sourceContributionId: "core.observability.trace",
                createdAt: "2026-05-26T00:00:00.000Z"
              }],
              errors: [{ contributionId: "core.observability.trace", message: "diagnostic failure" }]
            }
          : { effects: [], errors: [] }
      },
      applyWorkflowHookEffects: async () => {
        throw new Error("effect failed");
      }
    });

    expect(result.userMessageForModel).toBeTruthy();

    await result.session.dispose();
  });

  test("应优先暴露 SDK 原生基础工具名，而不是小写包装名", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-native-tools-"));
    const agentDir = join(cwd, ".runtime-core-test");
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

    const toolNames = availableToolNames(result);
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Write");
    expect(toolNames).toContain("Edit");
    expect(toolNames).toContain("Bash");
    expect(toolNames).toContain("Glob");
    expect(toolNames).toContain("Grep");
    expect(toolNames).toContain("WebSearch");
    expect(toolNames).toContain("WebFetch");
    expect(toolNames).toContain("TaskCreate");
    expect(toolNames).toContain("TaskUpdate");
    expect(toolNames).toContain("TaskList");
    expect(toolNames).toContain("TaskGet");
    expect(toolNames).toContain("TaskStop");
    expect(toolNames).toContain("ProcessOutput");
    expect(toolNames).toContain("ProcessStop");
    expect(toolNames).not.toContain("TaskReport");
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

  test("Coding 请求可直接发现 Web 和任务编排工具", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-coding-tools-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "coding-tool-session",
      cwd,
      agentDir,
      userMessage: "修复这个 TypeScript 错误",
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "acceptEdits"
    });

    const toolNames = availableToolNames(result);
    for (const toolName of ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "NotebookEdit", "ProcessOutput", "ProcessStop"]) {
      expect(toolNames).toContain(toolName);
    }
    for (const toolName of ["WebSearch", "WebFetch", "Delegate", "WaitForDelegations", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]) {
      expect(toolNames).toContain(toolName);
    }

    result.session.dispose();
  });

  test("开启 Guanlan 后应暴露 Guanlan 内置工具", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-guanlan-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    updateLumeConfigSection({
      source: "user",
      path: "webSearch",
      value: {
        strategy: "priority",
        providers: {
          guanlan: { enabled: true },
          duckduckgo: { enabled: true },
          bing: { enabled: true }
        }
      }
    });

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-guanlan-tools-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "guanlan-tool-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "acceptEdits"
    });

    const toolNames = availableToolNames(result);
    expect(toolNames).toContain("guanlan_search");
    expect(toolNames).toContain("guanlan_read");
    expect(toolNames).toContain("guanlan_hotnews");
    expect(toolNames).toContain("guanlan_research");

    result.session.dispose();
  });

  test("应通过 workspace MCP manager 注入 MCP 工具与资源工具", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-mcp-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-mcp-tools-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });
    const mcpTool: ToolDefinition = {
      name: "mcp__github__search_issues",
      description: "Search GitHub issues",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      async call() {
        return { type: "tool_result", tool_use_id: "", content: "ok" };
      }
    };
    const listResourcesTool: ToolDefinition = {
      name: "ListMcpResourcesTool",
      description: "List MCP resources",
      inputSchema: { type: "object", properties: {} },
      async call() {
        return { type: "tool_result", tool_use_id: "", content: "[]" };
      }
    };
    const readResourceTool: ToolDefinition = {
      name: "ReadMcpResourceTool",
      description: "Read MCP resource",
      inputSchema: { type: "object", properties: {}, required: ["serverId", "uri"] },
      async call() {
        return { type: "tool_result", tool_use_id: "", content: "{}" };
      }
    };
    let createRuntimeToolsCalls = 0;
    setWorkspaceMcpManagerForTesting({
      async createRuntimeTools(workspaceSlug: string) {
        createRuntimeToolsCalls += 1;
        expect(workspaceSlug).toBe("mcp-workspace");
        return { tools: [mcpTool, listResourcesTool, readResourceTool], diagnostics: [] };
      }
    } as unknown as WorkspaceMcpManager);

    try {
      const result = await createRuntimeCoreSession({
        lumeSessionId: "mcp-runtime-session",
        cwd,
        agentDir,
        provider: "anthropic",
        resolvedModelId: "claude-sonnet-4-5",
        apiKey: "test-key",
        workspaceSlug: "mcp-workspace",
        permissionMode: "acceptEdits"
      });

      const toolNames = availableToolNames(result);
      expect(createRuntimeToolsCalls).toBe(1);
      expect(toolNames).toContain("mcp__github__search_issues");
      expect(toolNames).toContain("ListMcpResourcesTool");
      expect(toolNames).toContain("ReadMcpResourceTool");
      expect((result.agent as unknown as { cfg?: { mcpServers?: unknown } }).cfg?.mcpServers).toBeUndefined();

      result.session.dispose();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("MCP diagnostics 不应阻塞内置工具", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-mcp-diagnostics-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-mcp-diagnostics-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });
    let createRuntimeToolsCalls = 0;
    setWorkspaceMcpManagerForTesting({
      async createRuntimeTools() {
        createRuntimeToolsCalls += 1;
        return {
          tools: [],
          diagnostics: [{ pluginName: "MCP: broken", severity: "warning", reason: "connection failed" }]
        };
      }
    } as unknown as WorkspaceMcpManager);

    try {
      const result = await createRuntimeCoreSession({
        lumeSessionId: "mcp-diagnostics-session",
        cwd,
        agentDir,
        provider: "anthropic",
        resolvedModelId: "claude-sonnet-4-5",
        apiKey: "test-key",
        workspaceSlug: "mcp-workspace",
        permissionMode: "acceptEdits"
      });

      expect(createRuntimeToolsCalls).toBe(1);
      expect(result.session.getActiveToolNames()).toContain("Read");
      expect(result.session.getActiveToolNames()).toContain("TaskCreate");
      expect(result.session.getActiveToolNames()).not.toContain("TaskReport");

      result.session.dispose();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("应把 Lume memory 工具 descriptor 保持为 memory source", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-memory-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    try {
      const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-memory-source-"));
      const agentDir = join(cwd, ".runtime-core-test");
      mkdirSync(agentDir, { recursive: true });

      const result = await createRuntimeCoreSession({
        lumeSessionId: "memory-source-session",
        cwd,
        agentDir,
        provider: "anthropic",
        resolvedModelId: "claude-sonnet-4-5",
        apiKey: "test-key",
        workspaceSlug: "memory-workspace",
        permissionMode: "acceptEdits"
      });

      expect(getRuntimeToolDescriptor("memory-source-session", "memory.search")).toMatchObject({
        source: "memory",
        metadata: {
          capability: "memory",
          category: "read"
        }
      });

      result.session.dispose();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("planner 子代理会话应应用内置 agent prompt 与工具策略", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-planner-subagent-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "planner-subagent-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "acceptEdits",
      threadType: "subagent",
      subagentType: "planner"
    });

    const systemPrompt = result.session.agent.state.systemPrompt;
    expect(systemPrompt).toStartWith("你是 Lume 的软件架构师与规划专家。");
    expect(systemPrompt).toContain("只读模式——禁止任何文件修改");
    expect(systemPrompt).not.toContain("executing one bound Subagent Task");
    expect(systemPrompt).not.toContain("Before ending this run, call TaskReport");

    const toolNames = result.session.getActiveToolNames();
    expect(toolNames).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(toolNames).not.toContain("Agent");
    expect(toolNames).not.toContain("Write");
    expect(toolNames).not.toContain("Edit");
    expect(toolNames).not.toContain("TaskReport");
    expect(toolNames).not.toContain("TodoWrite");

    result.session.dispose();
  });

  test("应直接注册 SDK 原生 AskUserQuestionTool，并在自动化执行时移除它", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-ask-user-"));
    const agentDir = join(cwd, ".runtime-core-test");
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

  test("应从 Lume plugin 目录加载命令型插件工具", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-plugin-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-plugin-cwd-"));
    const agentDir = join(cwd, ".runtime-core-test");
    const pluginDir = join(cwd, ".lume", "plugins", "demo");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "demo",
        tools: [{
          name: "demo_echo",
          description: "Echo demo payload",
          command: "node",
          args: ["-e", "process.stdout.write(process.env.PLUGIN_INPUT || '')"],
          metadata: {
            source: "plugin",
            category: "read",
            capability: "skill",
            riskLevel: "low",
            sideEffects: "external",
            allowedInPlanMode: true,
            isReadOnly: true,
            isConcurrencySafe: true,
            requiresApprovalByDefault: false
          }
        }]
      }),
      "utf-8"
    );

    updateLumeConfigSection({
      source: "system",
      path: "plugins.enabled",
      value: ["demo"]
    });
    updateLumeConfigSection({
      source: "system",
      path: "plugins.directories",
      value: [join(cwd, ".lume", "plugins")]
    });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "plugin-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan"
    });

    expect(availableToolNames(result)).toContain("demo_echo");
    expect(getRuntimeToolDescriptor("plugin-session", "demo_echo")).toMatchObject({
      canonicalName: "demo_echo",
      source: "plugin",
      metadata: {
        allowedInPlanMode: true,
        requiresApprovalByDefault: false,
        resultPolicy: { maxChars: 200_000 }
      }
    });

    result.session.dispose();
  });

  test("system prompt includes enabled plugin context", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-plugin-skill-context-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-plugin-skill-context-cwd-"));
    const agentDir = join(cwd, ".runtime-core-test");
    const pluginDir = join(cwd, ".lume", "plugins", "obsidian-bridge");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "obsidian-bridge",
        tools: [{
          name: "obsidian_status",
          description: "Report Obsidian bridge status",
          command: "node",
          args: ["-e", "process.stdout.write('ok')"],
          metadata: {
            source: "plugin",
            category: "read",
            capability: "skill",
            riskLevel: "low",
            sideEffects: "external",
            allowedInPlanMode: true,
            isReadOnly: true,
            isConcurrencySafe: true,
            requiresApprovalByDefault: false
          }
        }]
      }),
      "utf-8"
    );
    updateLumeConfigSection({
      source: "system",
      path: "plugins.enabled",
      value: ["obsidian-bridge"]
    });
    updateLumeConfigSection({
      source: "system",
      path: "plugins.directories",
      value: [join(cwd, ".lume", "plugins")]
    });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "plugin-skill-context-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      workspaceSlug: "default",
      permissionMode: "plan"
    });

    expect(result.runtimeContext).toContain("已启用插件：");
    expect(result.runtimeContext).toContain("obsidian-bridge");
    expect(result.runtimeContext).toContain("obsidian_status");

    result.session.dispose();
  });

  test("应为同一个 Lume session 使用稳定 transcript 目录", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-stable-dir-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });
    const first = getRuntimeCoreSessionDir("agent:main:test", agentDir);
    const second = getRuntimeCoreSessionDir("agent:main:test", agentDir);
    expect(first).toBe(second);
  });

  test("plan mode exposes read-only persistent Task tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-plan-md-thread-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "plan-md-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      workspaceSlug: "plan-md-workspace"
    });

    expect(result.tools.find((item) => item.name === "TaskList")).toBeTruthy();
    expect(result.tools.find((item) => item.name === "TaskGet")).toBeTruthy();

    result.session.dispose();
  });

  test("非 Plan 模式始终暴露 Worktree 工具", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-worktree-tools-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const ordinary = await createRuntimeCoreSession({
      lumeSessionId: "ordinary-worktree-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "acceptEdits",
      userMessage: "修复一个小的类型错误"
    });
    expect(getRuntimeToolDescriptor("ordinary-worktree-session", "EnterWorktree")).toBeDefined();
    expect(getRuntimeToolDescriptor("ordinary-worktree-session", "ExitWorktree")).toBeDefined();
    await ordinary.session.dispose();

    const plan = await createRuntimeCoreSession({
      lumeSessionId: "plan-worktree-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      userMessage: "请规划一个隔离 worktree"
    });
    expect(getRuntimeToolDescriptor("plan-worktree-session", "EnterWorktree")).toBeUndefined();
    expect(getRuntimeToolDescriptor("plan-worktree-session", "ExitWorktree")).toBeUndefined();
    await plan.session.dispose();
  });

  test("同一个 Lume session 应恢复既有 transcript", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-restore-"));
    const agentDir = join(cwd, ".runtime-core-test");
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

  test("derives stable private routing keys per provider, model, and thread", () => {
    const first = resolvePromptCachePolicy({
      channelProvider: "openai",
      provider: "openai",
      model: "gpt-test",
      threadId: "thread-a",
      baseUrl: "https://api.openai.com/v1"
    });
    const same = resolvePromptCachePolicy({
      channelProvider: "openai",
      provider: "openai",
      model: "gpt-test",
      threadId: "thread-a",
      baseUrl: "https://api.openai.com/v1"
    });
    const otherThread = resolvePromptCachePolicy({
      channelProvider: "openai",
      provider: "openai",
      model: "gpt-test",
      threadId: "thread-b",
      baseUrl: "https://api.openai.com/v1"
    });

    expect(first.routingKey).toBe(same.routingKey);
    expect(first.routingKey).not.toBe(otherThread.routingKey);
    expect(first.routingKey).toMatch(/^lume:v1:[a-f0-9]{64}$/);
    expect(first.routingKey).not.toContain("thread-a");
    expect(resolvePromptCachePolicy({
      channelProvider: "anthropic-compatible",
      provider: "anthropic",
      model: "claude-test",
      threadId: "thread-a",
      baseUrl: "https://proxy.example/v1"
    })).toEqual({ strategy: "implicit", runtimeRole: "user" });
  });

  test("重建 runtime 时应恢复 todo 工具状态并注入模型上下文", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-todo-restore-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });
    const sessionDir = getRuntimeCoreSessionDir("todo-restore-session", agentDir);
    const store = createFileBackedLumeRunStateStore(sessionDir);
    const createdAt = "2026-07-16T00:00:00.000Z";
    const previousRun: LumeRunState = {
      version: 1,
      runId: "previous-run",
      threadId: "todo-restore-session",
      rootAgentId: "root",
      currentAgentId: "root",
      status: "completed",
      input: { userMessage: "start", permissionMode: "acceptEdits" },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: { alwaysAllowedTools: [] },
      traceId: "trace-previous-run",
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt,
      updatedAt: createdAt
    };
    await store.create(previousRun);
    await store.appendItem("previous-run", {
      type: "todo_state",
      id: "todo-before-restart",
      todos: [
        { content: "A", activeForm: "Doing A", status: "completed" },
        { content: "B", activeForm: "Doing B", status: "completed" },
        { content: "C", activeForm: "Doing C", status: "completed" },
        { content: "D", activeForm: "Doing D", status: "in_progress" }
      ],
      currentActiveForm: "Doing D",
      createdAt: "2026-07-16T00:00:01.000Z"
    });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "todo-restore-session",
      cwd,
      agentDir,
      userMessage: "继续",
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "acceptEdits"
    });

    expect(result.runtimeContext).toContain('<todo_state source="lume_runtime">');
    expect(result.runtimeContext).toContain('"content":"D"');
    expect(result.userMessageForModel).toBe("继续");
    const todoTool = availableTools(result).find((tool) => tool.name === "TodoWrite");
    expect(todoTool).toBeTruthy();
    const completionGuard = (result.agent as any).baseOptions.completionGuard as () => Promise<string | undefined>;
    expect(await completionGuard()).toContain("正在进行：D");
    const update = await todoTool!.call({
      todos: [
        { content: "A", activeForm: "Doing A", status: "completed" },
        { content: "B", activeForm: "Doing B", status: "completed" },
        { content: "C", activeForm: "Doing C", status: "completed" },
        { content: "D", activeForm: "Doing D", status: "completed" },
        { content: "E", activeForm: "Doing E", status: "in_progress" }
      ]
    }, {} as any);
    expect(update.content).not.toContain("verification");
    expect(await completionGuard()).toContain("正在进行：E");

    const completed = await todoTool!.call({
      todos: [
        { content: "A", activeForm: "Doing A", status: "completed" },
        { content: "B", activeForm: "Doing B", status: "completed" },
        { content: "C", activeForm: "Doing C", status: "completed" },
        { content: "D", activeForm: "Doing D", status: "completed" },
        { content: "E", activeForm: "Doing E", status: "completed" }
      ]
    }, {} as any);
    expect(completed.content).toBe("No active todos.");
    expect(await completionGuard()).toBeUndefined();
    await result.session.dispose();
  });

  test("应接受显式 resolvedModel，避免重新回退到 catalog 查询", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-explicit-model-"));
    const agentDir = join(cwd, ".runtime-core-test");
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

  test("OpenAI Responses 渠道应创建 responses provider", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-responses-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "responses-model-session",
      cwd,
      agentDir,
      provider: "openai",
      openaiApiMode: "responses",
      resolvedModelId: "gpt-custom",
      apiKey: "test-key",
      permissionMode: "plan"
    });

    expect(result.agent.getApiType()).toBe("openai-responses");
    result.session.dispose();
  });

  test("prepareRuntimeCoreAttempt 应保留渠道的 OpenAI API 模式", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-responses-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    const channel = createChannel({
      name: "responses-provider",
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      apiKey: "test-key",
      openaiApiMode: "responses",
      enabled: true,
      models: [{ id: "gpt-custom", name: "GPT Custom", enabled: true, capabilities: { chat: true } }]
    });
    const thread = createAgentThread("responses thread", channel.id, undefined, undefined, "gpt-custom");

    const prepared = await prepareRuntimeCoreAttempt({
      input: {
        threadId: thread.id,
        userMessage: "hello",
        permissionMode: "default",
        chatType: "direct"
      },
      runtime: {
        sessionId: thread.id,
        channelId: channel.id,
        resolvedModelId: "gpt-custom",
        threadType: "main"
      }
    });

    expect("status" in prepared ? undefined : prepared.openaiApiMode).toBe("responses");
  });

  test("resolveSubagentModelOverride 应优先显式 model，其次使用子 Agent 默认模型，否则继承父对话模型", () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-subagent-model-config-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const anthropicChannel = createChannel({
      name: "anthropic-main",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "anthropic-key",
      enabled: true,
      defaultModelId: "claude-sonnet-4-5",
      models: [
        { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", enabled: true, capabilities: { chat: true } },
      ]
    });
    const openaiChannel = createChannel({
      name: "openai-subagent",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
      openaiApiMode: "responses",
      enabled: true,
      defaultModelId: "gpt-5.4-mini",
      models: [
        { id: "gpt-5.4-mini", name: "GPT-5.4 mini", enabled: true, capabilities: { chat: true } },
      ]
    });

    updateLumeConfigSection({
      source: "system",
      path: "models.subagent",
      value: { defaultModelRef: "openai/gpt-5.4-mini" }
    });

    const explicit = resolveSubagentModelOverride({
      toolInput: { model: "anthropic/claude-sonnet-4-5" },
      workspaceSlug: undefined,
    });
    expect(explicit.source).toBe("input");
    expect(explicit.resolvedModelId).toBe("claude-sonnet-4-5");
    expect(explicit.apiType).toBe("anthropic-messages");

    const configured = resolveSubagentModelOverride({
      toolInput: {},
      workspaceSlug: undefined,
    });
    expect(configured.source).toBe("config");
    expect(configured.resolvedModelId).toBe("gpt-5.4-mini");
    expect(configured.apiType).toBe("openai-responses");

    updateLumeConfigSection({
      source: "system",
      path: "models.subagent",
      value: {}
    });

    const inherited = resolveSubagentModelOverride({
      toolInput: {},
      workspaceSlug: undefined,
    });
    expect(inherited.source).toBe("inherit");
    expect(inherited.resolvedModelId).toBeUndefined();
    expect(inherited.apiType).toBeUndefined();

    void anthropicChannel;
    void openaiChannel;
    rmSync(configDir, { recursive: true, force: true });
  });

  test("应将 Lume prompt builder 的系统提示和动态上下文注入 runtime session", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-config-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspaceSlug = "prompt-injection";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    writeFileSync(join(workspacePath, "AGENTS.md"), "# Workspace Rules\n- Always verify edits before final output.", "utf-8");
    writeFileSync(join(workspacePath, "SOUL.md"), "# Persona\n- Be sharp, calm, and warm.", "utf-8");

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-prompt-"));
    const agentDir = join(cwd, ".runtime-core-test");
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
    expect(systemPrompt).toContain("你是 Lume。你在这个本地优先的工作区里帮助用户思考、构建、整理并推进工作。");
    expect(systemPrompt).toContain("## 工作区");
    expect(systemPrompt).toContain("~/.lume/lume.yaml");
    expect(systemPrompt).not.toContain(".lume-config");
    expect(systemPrompt).toContain("## 工作区上下文");
    expect(systemPrompt).toContain("## AGENTS.md");
    expect(systemPrompt).toContain("Always verify edits before final output.");
    expect(systemPrompt).toContain("不要发明工具名");
    expect(systemPrompt).not.toContain("<thread_state>");
    expect(result.runtimeContext).toContain("<thread_state>");
    expect(result.runtimeContext).toContain("threadType: main");
    expect(result.runtimeContext).toContain("chatType: direct");
    // modelId/title 属模型无可执行动作的噪音元数据，不再注入 thread_state
    expect(result.runtimeContext).not.toContain("modelId:");
    expect(result.runtimeContext).not.toContain("title:");
    expect(result.runtimeContext).not.toContain("Preferred capability route:");
    expect(result.runtimeContext).toContain("<working_directory>");

    result.session.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("runRuntimeCoreAttempt 不应在工作区线程目录创建 .lume-config 映射", async () => {
    const prevMockSuccess = process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS;
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-attempt-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS = "1";

    const projectPath = mkdtempSync(join(tmpdir(), "lume-runtime-core-attempt-project-"));
    const workspace = createAgentWorkspace("No Mirror Workspace", { projectPath });
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
          enabled: true
        }
      ]
    });

    const thread = createAgentThread("runtime attempt no mirror", channel.id, workspace.id, undefined, "gpt-5.4-mini");
    const sessionId = thread.id;
    const threadDir = getAgentSessionWorkspacePath(workspace.slug, sessionId);

    const result = await runRuntimeCoreAttempt(
      {
        input: {
          threadId: sessionId,
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
        onBrowserAuthRequest: () => {},
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
      delete process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS;
    } else {
      process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS = prevMockSuccess;
    }
    rmSync(configDir, { recursive: true, force: true });
  });

  test("subagent runtime 使用 child sessionId 时，不应因更新不存在的子线程 meta 而失败", async () => {
    const prevMockSuccess = process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS;
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-subagent-thread-meta-"));
    process.env.LUME_CONFIG_DIR = configDir;
    process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS = "1";

    const projectPath = mkdtempSync(join(tmpdir(), "lume-runtime-core-subagent-project-"));
    const workspace = createAgentWorkspace("Subagent Parent Workspace", { projectPath });
    const channel = createChannel({
      name: "mock-subagent-thread-meta",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      enabled: true,
      defaultModelId: "gpt-5.4-mini",
      models: [
        {
          id: "gpt-5.4-mini",
          name: "gpt-5.4-mini",
          enabled: true
        }
      ]
    });

    const parentThread = createAgentThread("subagent parent thread", channel.id, workspace.id, undefined, "gpt-5.4-mini");
    const childSessionId = "child-runtime-session";

    const result = await runRuntimeCoreAttempt(
      {
        input: {
          threadId: childSessionId,
          userMessage: "hello child runtime",
          permissionMode: "plan",
          chatType: "direct"
        },
        runtime: {
          sessionId: childSessionId,
          deliveryThreadId: parentThread.id,
          subagentRunId: "subagent-run-fixed",
          channelId: channel.id,
          resolvedModelId: "gpt-5.4-mini",
          workspaceId: workspace.id,
          threadType: "subagent"
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

    expect(result.status).toBe("completed");

    if (prevMockSuccess === undefined) {
      delete process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS;
    } else {
      process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS = prevMockSuccess;
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
    const agentDir = join(cwd, ".runtime-core-test");
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

  test("Lume runtime 不应把工作区配置禁用的 skill 注册到 SDK", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-disabled-skills-config-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspaceSlug = "runtime-disabled-skill-registration";
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
    updateLumeConfigSection({
      workspaceSlug,
      source: "user",
      path: "skills.disabled",
      value: ["planner"]
    });

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-disabled-skills-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "disabled-skill-runtime-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      workspaceSlug,
      workspaceName: "Disabled Skill Workspace"
    });

    const init = await result.agent.getInitializationResult();
    expect(init.skills).not.toContain("planner");

    result.session.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("Lume runtime 禁用 workspace skill 时不应误伤同名用户全局 skill", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-disabled-skills-user-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    process.env.ALICE_CONFIG_DIR = join(configDir, "alice");

    const workspaceSlug = "runtime-disabled-skill-user-fallback";
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const workspaceSkillDir = join(workspacePath, "skills", "planner");
    const userSkillDir = join(getAliceUserSkillsDir(), "planner");
    mkdirSync(workspaceSkillDir, { recursive: true });
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(
      join(workspaceSkillDir, "SKILL.md"),
      "---\nname: Workspace Planner\ndescription: workspace planning skill\n---\nWorkspace plan.",
      "utf-8"
    );
    writeFileSync(
      join(userSkillDir, "SKILL.md"),
      "---\nname: User Planner\ndescription: user planning skill\n---\nUser plan.",
      "utf-8"
    );
    updateLumeConfigSection({
      workspaceSlug,
      source: "user",
      path: "skills.disabled",
      value: ["planner"]
    });

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-disabled-skills-user-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "disabled-skill-user-runtime-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      workspaceSlug,
      workspaceName: "Disabled Skill User Workspace"
    });

    const init = await result.agent.getInitializationResult();
    expect(init.skills).toContain("planner");

    result.session.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("Lume runtime 不应让默认 skill 目录绕过工作区禁用配置", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-disabled-default-skills-config-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const workspaceSlug = "runtime-disabled-default-skill";
    const defaultSkillDir = join(getDefaultSkillsDir(), "default-review");
    mkdirSync(defaultSkillDir, { recursive: true });
    writeFileSync(
      join(defaultSkillDir, "SKILL.md"),
      "---\nname: Default Review\ndescription: default review skill\n---\nReview.",
      "utf-8"
    );
    updateLumeConfigSection({
      workspaceSlug,
      source: "user",
      path: "skills.disabled",
      value: ["default-review"]
    });

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-disabled-default-skills-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "disabled-default-skill-runtime-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      workspaceSlug,
      workspaceName: "Disabled Default Skill Workspace"
    });

    const init = await result.agent.getInitializationResult();
    expect(init.skills).not.toContain("default-review");

    result.session.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("Lume runtime 应加载用户全局 ~/.lume/skills", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-global-skills-config-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const skillDir = join(configDir, "skills", "global-planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: global-planner",
        "description: global planning skill",
        "---",
        "# Global Planner",
        "",
        "Use this skill for reusable planning.",
      ].join("\n"),
      "utf-8"
    );

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-global-skills-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "global-skill-runtime-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      workspaceSlug: "global-skill-workspace",
      workspaceName: "Global Skills Workspace"
    });

    const init = await result.agent.getInitializationResult();
    expect(init.skills).toContain("global-planner");

    result.session.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("Lume runtime 应加载 Alice 兼容用户全局 ~/.alice/skills", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-alice-global-skills-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    process.env.ALICE_CONFIG_DIR = join(configDir, "alice");

    const skillDir = join(getAliceUserSkillsDir(), "alice-global-planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: alice-global-planner",
        "description: Alice global planning skill",
        "---",
        "# Alice Global Planner",
        "",
        "Use this Alice-compatible global skill for reusable planning.",
      ].join("\n"),
      "utf-8"
    );

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-alice-global-skills-"));
    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "alice-global-skill-runtime-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      workspaceSlug: "alice-global-skill-workspace",
      workspaceName: "Alice Global Skills Workspace"
    });

    const init = await result.agent.getInitializationResult();
    expect(init.skills).toContain("alice-global-planner");

    result.session.dispose();
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("Lume runtime 应加载工作目录 .lume/skills", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-workdir-skills-config-"));
    process.env.LUME_CONFIG_DIR = configDir;

    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-workdir-skills-"));
    const skillDir = join(cwd, ".lume", "skills", "project-planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: project-planner",
        "description: project planning skill",
        "---",
        "# Project Planner",
        "",
        "Use this project-local skill for planning.",
      ].join("\n"),
      "utf-8"
    );

    const agentDir = join(cwd, ".runtime-core-test");
    mkdirSync(agentDir, { recursive: true });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "workdir-skill-runtime-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
      workspaceSlug: "workdir-skill-workspace",
      workspaceName: "Workdir Skills Workspace"
    });

    const init = await result.agent.getInitializationResult();
    expect(init.skills).toContain("project-planner");

    result.session.dispose();
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("buildSidecarSubagentRunContext 应统一 registry 与 SDK 使用的 subagent_run_id", () => {
    const result = buildSidecarSubagentRunContext({
      parentThreadId: "parent-thread",
      parentToolUseId: "agent-tool-use-1",
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
    expect(result.registryInput.parentToolUseId).toBe("agent-tool-use-1");
    expect(result.registryInput.parentThreadId).toBe("parent-thread");
    expect(result.registryInput.rootThreadId).toBe("root-thread");
    expect(result.registryInput.parentRunId).toBe("parent-run");
  });

  test("buildSidecarSubagentExecutionInput 应仅在显式后台模式下保留 run_in_background", () => {
    const background = buildSidecarSubagentExecutionInput({
      forwardedToolInput: {
        prompt: "后台执行",
        run_in_background: true,
        isolation: "remote"
      },
      modelOverride: { source: "inherit" },
      runInBackground: true
    });

    const foreground = buildSidecarSubagentExecutionInput({
      forwardedToolInput: {
        prompt: "前台执行",
        run_in_background: true
      },
      modelOverride: { source: "inherit" },
      runInBackground: false
    });

    expect(background.run_in_background).toBe(true);
    expect(background.isolation).toBeUndefined();
    expect(foreground.run_in_background).toBe(false);
  });

  test("前台 subagent 必须等待执行结果，不能提前让主 agent 继续", async () => {
    let resolveExecution: ((value: {
      status: "completed";
      output: string;
      result: { type: "tool_result"; tool_use_id: string; content: string };
    }) => void) | undefined;
    let settled = false;

    const pending = new Promise<{
      status: "completed";
      output: string;
      result: { type: "tool_result"; tool_use_id: string; content: string };
    }>((resolve) => {
      resolveExecution = resolve;
    });
    const foreground = runForegroundSubagentWithTimeout({
      execution: pending,
      childThreadId: "child-thread",
      timeoutMs: 0,
      stopSubagent: async () => false
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveExecution?.({
      status: "completed",
      output: "writer result",
      result: { type: "tool_result", tool_use_id: "", content: "writer result" }
    });

    await expect(foreground).resolves.toMatchObject({
      status: "completed",
      output: "writer result"
    });
    expect(settled).toBe(true);
  });

  test("前台 subagent 超时时应取消子任务并返回错误结果", async () => {
    let stoppedThreadId = "";
    const execution = new Promise<{
      status: "completed";
      output: string;
      result: { type: "tool_result"; tool_use_id: string; content: string };
    }>(() => {});

    const result = await runForegroundSubagentWithTimeout({
      execution,
      childThreadId: "child-thread-timeout",
      timeoutMs: 1,
      stopSubagent: async (threadId) => {
        stoppedThreadId = threadId;
        return true;
      }
    });

    expect(stoppedThreadId).toBe("child-thread-timeout");
    expect(result.status).toBe("timed_out");
    expect(result.result).toMatchObject({
      type: "tool_result",
      is_error: true
    });
    expect(result.result.content).toContain("timed out");
  });

  test("LUME_SUBAGENT_FOREGROUND_TIMEOUT_MS 三态解析：缺省回默认 / \"0\" 关闭 / 非法值回默认", () => {
    const key = "LUME_SUBAGENT_FOREGROUND_TIMEOUT_MS";
    const prev = process.env[key];
    try {
      delete process.env[key];
      expect(resolveForegroundSubagentTimeoutMs()).toBe(600_000);
      process.env[key] = "0";
      expect(resolveForegroundSubagentTimeoutMs()).toBe(0);
      process.env[key] = "not-a-number";
      expect(resolveForegroundSubagentTimeoutMs()).toBe(600_000);
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  test("未审批的插件 command tool 触发 sensitive gate ask（§8.1/§14.2 Phase 4A ask→ask）", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-runtime-core-plugin-gate-config-"));
    process.env.LUME_CONFIG_DIR = configDir;
    const cwd = mkdtempSync(join(tmpdir(), "lume-runtime-core-plugin-gate-cwd-"));
    const agentDir = join(cwd, ".runtime-core-test");
    const pluginDir = join(cwd, ".lume", "plugins", "demo");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "demo",
        tools: [{
          name: "demo_echo",
          description: "Echo demo payload",
          command: "node",
          args: ["-e", "process.stdout.write(process.env.PLUGIN_INPUT || '')"],
          metadata: {
            source: "plugin",
            category: "read",
            capability: "skill",
            riskLevel: "low",
            sideEffects: "external",
            allowedInPlanMode: true,
            isReadOnly: true,
            isConcurrencySafe: true,
            requiresApprovalByDefault: false
          }
        }]
      }),
      "utf-8",
    );
    updateLumeConfigSection({ source: "system", path: "plugins.enabled", value: ["demo"] });
    updateLumeConfigSection({
      source: "system",
      path: "plugins.directories",
      value: [join(cwd, ".lume", "plugins")]
    });

    const result = await createRuntimeCoreSession({
      lumeSessionId: "plugin-gate-session",
      cwd,
      agentDir,
      provider: "anthropic",
      resolvedModelId: "claude-sonnet-4-5",
      apiKey: "test-key",
      permissionMode: "plan",
    });

    // The demo plugin has no install record → checkSensitiveCapability returns "ask"
    // → evaluatePluginSensitiveGate surfaces "ask" (Phase 4A: no longer folded into block;
    // attempt.ts threads it through the interactive permission pipeline in Task 4). Verify
    // via the real runtime + the registered descriptor (gate reads
    // descriptor.definition.runtimeMetadata.pluginId).
    const runtime = new PluginPermissionRuntime({
      stateStore: new FilePluginStateStore(join(cwd, ".lume", "plugins-state.json")),
    });
    const descriptor = getRuntimeToolDescriptor("plugin-gate-session", "demo_echo");
    expect(descriptor).toBeDefined();
    const gate = await evaluatePluginSensitiveGate({
      descriptor: descriptor!,
      runtime,
      workspaceSlug: undefined,
    });
    expect(gate.decision).toBe("ask");
    expect(gate.pluginId).toBe("demo");
    expect(gate.capabilityKey).toBe("commandTool:demo_echo");

    result.session.dispose();
  });
});
