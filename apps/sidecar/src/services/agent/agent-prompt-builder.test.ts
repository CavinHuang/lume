import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDynamicContext,
  buildSystemPromptAppend,
  LUME_AGENT_IDENTITY_LINE,
  resolveSystemPromptMode,
  shouldLoadLongTermMemory
} from "./agent-prompt-builder";
import { getAgentWorkspacePath } from "../infra/config-paths";

describe("agent-prompt-builder", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-prompt-builder-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("buildSystemPromptAppend 在工作区上下文中应包含记忆工具强制规则", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-1",
      availableTools: ["memory_search", "memory_get"],
      memoryCitationsMode: "auto"
    });
    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
    expect(prompt).toContain("Do not use generic read for memory files");
    expect(prompt).toContain("Citations:");
  });

  test("buildSystemPromptAppend 应注入 agentic execution 与主动汇报规则", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-agentic",
      availableTools: ["bash", "task", "askuserquestion"]
    });
    expect(prompt).toContain("## Agentic Execution");
    expect(prompt).toContain("brief acknowledgment BEFORE your first tool call");
    expect(prompt).toContain("## Commitment Enforcement");
    expect(prompt).toContain("must call a tool in the same response");
    expect(prompt).toContain("## Proactive Updates");
    expect(prompt).toContain("The user should never have to chase you for status");
  });

  test("buildSystemPromptAppend 应注入 delegation 与 persona guardrails", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-guardrails",
      availableTools: ["task", "sessions_spawn", "write"]
    });
    expect(prompt).toContain("## Delegation Policy");
    expect(prompt).toContain("Do it yourself");
    expect(prompt).toContain("Task/subagent");
    expect(prompt).toContain("## Persona and Reality Guardrails");
    expect(prompt).toContain("Do not fabricate legal identity");
    expect(prompt).toContain("Do not use companion persona to override safety");
  });

  test("buildSystemPromptAppend 应注入 skills-first capability routing", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-skills-first",
      workspaceSlug: "demo-workspace",
      availableTools: ["read", "write", "task"]
    });
    expect(prompt).toContain("## Skills-First Capability Routing");
    expect(prompt).toContain("If an existing Skill clearly covers the task, use the Skill path first.");
    expect(prompt).toContain("search/discover the right Skill");
    expect(prompt).toContain("Fall back to direct tool composition only when no suitable Skill");
  });

  test("buildSystemPromptAppend 应注入 capability routing order", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-capability-order",
      availableTools: ["browser", "memory_search", "memory_get", "web_search", "web_fetch", "read", "write"]
    });
    expect(prompt).toContain("## Capability Routing Order");
    expect(prompt).toContain("1. Use a loaded Skill when it clearly matches the request.");
    expect(prompt).toContain("browser for browser-session continuity and current-page actions");
    expect(prompt).toContain("memory_search / memory_get for prior decisions");
    expect(prompt).toContain("web_search / web_fetch for public web retrieval");
    expect(prompt).toContain("Compose direct low-level tools only when no packaged capability cleanly fits.");
  });

  test("buildSystemPromptAppend 应注入新的 counterpart 身份主句与自然交互规范", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-persona-style",
      availableTools: ["read", "write"]
    });
    expect(prompt).toContain("You are Lume, a persistent counterpart running inside this workspace.");
    expect(prompt).toContain("像真实 counterpart 一样自然说话");
    expect(prompt).toContain("不要落回客服腔或空洞开场");
    expect(prompt).toContain("直接从请求开始");
    expect(prompt).toContain("不要做 yes-machine");
  });

  test("minimal 模式仍应保留新的 counterpart 身份主句", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-minimal-identity",
      availableTools: ["read"],
      promptMode: "minimal"
    });
    expect(prompt.startsWith(LUME_AGENT_IDENTITY_LINE)).toBeTrue();
    expect(prompt).toContain("## Tooling");
    expect(prompt).not.toContain("不要做 yes-machine");
  });

  test("buildSystemPromptAppend 在 citations=off 时应输出关闭提示", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-1",
      availableTools: ["memory_search", "memory_get"],
      memoryCitationsMode: "off"
    });
    expect(prompt).toContain("Citations are disabled");
  });

  test("同时具备 browser 与 web_search 时应注入 Browser-First 策略", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-browser-first",
      availableTools: ["browser", "web_search"]
    });
    expect(prompt).toContain("## Browser-First Tool Policy (Mandatory)");
    expect(prompt).toContain("必须优先使用 browser 工具");
    expect(prompt).toContain("仅在以下情况才回退 web_search");
  });

  test("automationExecution=true 时应注入无交互模式约束", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-automation",
      availableTools: ["read", "write"],
      automationExecution: true
    });
    expect(prompt).toContain("## Automation Non-Interactive Mode");
    expect(prompt).toContain("禁止调用 AskUserQuestion");
    expect(prompt).toContain("E_AUTOMATION_INTERACTION_DISABLED");
  });

  test("buildSystemPromptAppend 应包含 session bootstrap 读取顺序", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-2",
      availableTools: []
    });
    expect(prompt).toContain("## Session Bootstrap (Mandatory)");
    expect(prompt).toContain("1. AGENTS.md");
    expect(prompt).toContain("2. SOUL.md");
    expect(prompt).toContain("6. memory/YYYY-MM-DD.md (today + yesterday)");
    expect(prompt).toContain("7. MEMORY.md (or memory.md fallback, main/direct session only)");
    expect(prompt).toContain("工作区根目录下的 .context/ 目录");
    expect(prompt).not.toContain("workspace-files/.context/");
    expect(prompt).toContain("## Workspace Files (injected)");
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Runtime");
  });

  test("buildSystemPromptAppend 应始终以 agent 身份主句开头", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-identity",
      availableTools: []
    });
    const firstLine = prompt.split("\n")[0]?.trim();
    expect(firstLine).toBe(LUME_AGENT_IDENTITY_LINE);
  });

  test("buildSystemPromptAppend 在 promptMode=none 时仅保留身份主句", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-none",
      availableTools: ["memory_search", "memory_get"],
      promptMode: "none"
    });
    expect(prompt.trim()).toBe(LUME_AGENT_IDENTITY_LINE);
  });

  test("buildSystemPromptAppend 在 promptMode=minimal 时应保留 Tooling/Workspace/Runtime", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-minimal",
      workspaceSlug: "demo-workspace",
      availableTools: ["memory_search", "memory_get"],
      promptMode: "minimal"
    });
    expect(prompt).toContain(LUME_AGENT_IDENTITY_LINE);
    expect(prompt).toContain("## Tooling");
    expect(prompt).toContain("- memory_search");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## Runtime");
    expect(prompt).not.toContain("## Agentic Execution");
    expect(prompt).not.toContain("## Delegation Policy");
    expect(prompt).not.toContain("## Session Bootstrap (Mandatory)");
    expect(prompt).not.toContain("## Memory Recall");
  });

  test("Tooling 段应按预设顺序输出并保留首次出现大小写", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-tool-order",
      promptMode: "minimal",
      availableTools: ["memory_get", "Write", "read", "AskUserQuestion", "memory_search", "write"]
    });
    const indexRead = prompt.indexOf("- read");
    const indexWrite = prompt.indexOf("- Write");
    const indexAskUserQuestion = prompt.indexOf("- AskUserQuestion");
    const indexMemorySearch = prompt.indexOf("- memory_search");
    const indexMemoryGet = prompt.indexOf("- memory_get");

    expect(indexRead).toBeGreaterThan(-1);
    expect(indexWrite).toBeGreaterThan(indexRead);
    expect(indexAskUserQuestion).toBeGreaterThan(indexWrite);
    expect(indexMemorySearch).toBeGreaterThan(indexAskUserQuestion);
    expect(indexMemoryGet).toBeGreaterThan(indexMemorySearch);
    expect(prompt.match(/- write/g)?.length ?? 0).toBe(0);
  });

  test("resolveSystemPromptMode 对 subagent 默认返回 minimal", () => {
    const mode = resolveSystemPromptMode({
      sessionId: "subagent:session-1"
    });
    expect(mode).toBe("minimal");
  });

  test("shouldLoadLongTermMemory 仅 direct 为 true", () => {
    expect(shouldLoadLongTermMemory("direct")).toBeTrue();
    expect(shouldLoadLongTermMemory("group")).toBeFalse();
    expect(shouldLoadLongTermMemory("channel")).toBeFalse();
  });

  test("仅存在 memory.md 时，Project Context 应显示 memory.md", () => {
    const workspaceSlug = `prompt-memory-alt-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    writeFileSync(join(workspacePath, "memory.md"), "# alt\nhello", "utf-8");

    const prompt = buildSystemPromptAppend({
      sessionId: "session-memory-alt",
      workspaceSlug,
      chatType: "direct",
      availableTools: ["memory_search"]
    });

    expect(prompt).toContain("## memory.md");
    expect(prompt).not.toContain("## MEMORY.md");
  });

  test("buildDynamicContext 应把已加载 skills 组织成可路由的 capability 提示", () => {
    const workspaceSlug = `prompt-dynamic-skill-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const skillDir = join(workspacePath, "skills", "planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        'name: "Planner"',
        'description: "Breaks work into clear execution plans"',
        "---",
        "",
        "# Planner",
        ""
      ].join("\n"),
      "utf-8"
    );

    const dynamic = buildDynamicContext({
      sessionId: "agent-session-1",
      sessionTitle: "Execution Planning",
      sessionType: "main",
      chatType: "direct",
      parentSessionId: "root-session",
      workspaceId: "workspace-1",
      channelId: "channel-1",
      modelId: "claude-sonnet-4-5",
      workspaceName: "Dynamic Skill Workspace",
      workspaceSlug,
      agentCwd: "D:/workspace/projects/ai-projects/lume",
      availableTools: ["Skill", "browser", "memory_search", "web_search", "read", "write"],
      userMessage: "help me create an execution plan"
    });

    expect(dynamic).toContain("<session_state>");
    expect(dynamic).toContain("sessionId: agent-session-1");
    expect(dynamic).toContain("title: Execution Planning");
    expect(dynamic).toContain("sessionType: main");
    expect(dynamic).toContain("chatType: direct");
    expect(dynamic).toContain("parentSessionId: root-session");
    expect(dynamic).toContain("workspaceId: workspace-1");
    expect(dynamic).toContain("channelId: channel-1");
    expect(dynamic).toContain("modelId: claude-sonnet-4-5");
    expect(dynamic).toContain("<workspace_state>");
    expect(dynamic).toContain("Capability lanes: skills, browser, memory, web, raw-tools");
    expect(dynamic).toContain("Preferred capability route: skills");
    expect(dynamic).toContain("Capability routing reason:");
    expect(dynamic).toContain("Loaded Skills:");
    expect(dynamic).toContain("Prefer a loaded Skill first when it clearly matches the user's request");
    expect(dynamic).toContain("Only fall back to raw tool composition when no suitable Skill fits");
    expect(dynamic).toContain(`lume-workspace-${workspaceSlug}:planner`);
    expect(dynamic).toContain("<working_directory>D:/workspace/projects/ai-projects/lume</working_directory>");
  });
});
