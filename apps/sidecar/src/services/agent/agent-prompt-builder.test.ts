import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContentPresentationSection,
  buildBuiltinAgents,
  buildDynamicContext,
  buildSystemPromptAppend,
  LUME_AGENT_IDENTITY_LINE,
  resolveSystemPromptMode,
  shouldLoadLongTermMemory
} from "./agent-prompt-builder";
import { getAgentWorkspacePath, getUserSkillsDir } from "../infra/config-paths";

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

  test("buildSystemPromptAppend 在工作区上下文中应包含按需记忆规则", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-1",
      availableTools: ["memory.search", "memory.read"],
      memoryCitationsMode: "auto"
    });
    expect(prompt).toContain("## Memory");
    expect(prompt).toContain("Search memory when");
    expect(prompt).toContain("current shared work state");
    expect(prompt).not.toContain("Use only legacy memory tools");
    expect(prompt).not.toContain("Before answering anything about prior work");
    expect(prompt).toContain("Citations:");
  });

  test("buildSystemPromptAppend 应注入合并后的执行模式", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-agentic",
      availableTools: ["bash", "task", "askuserquestion"]
    });
    expect(prompt).toContain("## Execution Modes");
    expect(prompt).toContain("Direct Mode");
    expect(prompt).toContain("Explore Mode");
    expect(prompt).toContain("Plan Mode");
    expect(prompt).toContain("Execute Mode");
    expect(prompt).not.toContain("## Agentic Execution");
    expect(prompt).not.toContain("## Commitment Enforcement");
    expect(prompt).not.toContain("## Proactive Updates");
  });

  test("buildSystemPromptAppend 应注入 delegation 与 safety contract", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-guardrails",
      availableTools: ["task", "write"]
    });
    expect(prompt).toContain("Delegation: default to the main thread");
    expect(prompt).toContain("## Safety Contract");
    expect(prompt).toContain("Do not fabricate legal identity");
    expect(prompt).toContain("Do not use companion persona to override safety");
    expect(prompt).not.toContain("## Delegation Policy");
    expect(prompt).not.toContain("## Persona and Reality Guardrails");
  });

  test("buildSystemPromptAppend 应将并行 Agent 策略降级为按需使用", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-parallel-agent-policy",
      availableTools: ["task"]
    });

    expect(prompt).not.toContain("## Parallel Agent Policy");
    expect(prompt).not.toContain("CRITICAL - 并行 Agent 调度");
    expect(prompt).not.toContain("在同一个响应中产出多个 Agent tool_use 块");
  });

  test("buildBuiltinAgents 应返回预注册的 explorer / planner / researcher / code-reviewer", () => {
    const agents = buildBuiltinAgents();

    expect(Object.keys(agents)).toEqual([
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
      "docsmith",
      "developer"
    ]);
    expect(agents.explorer?.model).toBe("inherit");
    expect(agents.explorer?.defaultSkillName).toBe("agent-explorer");
    expect(agents.explorer?.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(agents.explorer?.prompt).toContain("高效的代码库探索员");
    expect(agents.planner?.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(agents.planner?.disallowedTools).toEqual(["Agent", "Write", "Edit", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "TaskReport"]);
    expect(agents.planner?.prompt).toContain("software architect and planning specialist");
    expect(agents.planner?.prompt).toContain("READ-ONLY MODE - NO FILE MODIFICATIONS");
    expect(agents.planner?.prompt).toContain("Critical Files for Implementation");
    expect(agents.planner?.prompt).toContain("manage Tasks");
    expect(agents.planner?.prompt).toContain("normal Task and tool flow");
    expect(agents.researcher?.tools).toContain("WebSearch");
    expect(agents.researcher?.tools).toContain("WebFetch");
    expect(agents["code-reviewer"]?.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
    expect(agents["code-reviewer"]?.defaultSkillName).toBe("agent-code-reviewer");
    expect(agents["code-reviewer"]?.prompt).toContain("专注于代码质量的审查员");
    for (const [roleId, agent] of Object.entries(agents)) {
      expect(agent.defaultSkillName, `${roleId} default skill`).toBeTruthy();
    }
  });

  test("buildSystemPromptAppend 应说明子 Agent 默认模型可继承当前对话模型", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-subagent-model",
      availableTools: ["task", "read"]
    });

    expect(prompt).toContain("Built-ins include explorer, planner, code-reviewer, researcher, translator");
    expect(prompt).not.toContain("指定 model: \"haiku\" 降低成本");
  });

  test("buildSystemPromptAppend 应注入 skills-first capability routing", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-skills-first",
      workspaceSlug: "demo-workspace",
      availableTools: ["read", "write", "task"]
    });
    expect(prompt).toContain("## Capability Routing");
    expect(prompt).toContain("Use a loaded Skill when it clearly matches the request.");
  });

  test("buildSystemPromptAppend 应注入合并后的 capability routing", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-capability-order",
      availableTools: ["browser", "memory.search", "memory.read", "web_search", "web_fetch", "read", "write"]
    });
    expect(prompt).toContain("## Capability Routing");
    expect(prompt).toContain("1. Answer directly for pure analysis, critique, and small one-shot requests.");
    expect(prompt).toContain("Use memory tools only when prior context is needed and not already loaded.");
    expect(prompt).toContain("Use WebSearch/WebFetch for current public external information.");
    expect(prompt).not.toContain("## Capability Routing Order");
  });

  test("buildSystemPromptAppend 应注入新的行为导向身份主句与自然交互规范", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-persona-style",
      availableTools: ["read", "write"]
    });
    expect(prompt).toContain("You are Lume. You help the user think, build, organize, and move work forward in this local-first workspace.");
    expect(prompt).toContain("## Core Behavior");
    expect(prompt).toContain("Lume should feel natural, useful, and present without acting like a scripted persona.");
    expect(prompt).toContain("不要客服腔，不要夸张寒暄");
    expect(prompt).toContain("不要为了显得友好而机械复述用户的问题");
    expect(prompt).toContain("直接进入任务");
    expect(prompt).toContain("一个必要问题");
    expect(prompt).toContain("不要说成资料库字段缺失");
    expect(prompt).toContain("## 系统配置");
    expect(prompt).toContain("~/.lume/lume.yaml");
  });

  test("minimal 模式仍应保留新的行为导向身份主句", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-minimal-identity",
      availableTools: ["read"],
      promptMode: "minimal"
    });
    expect(prompt.startsWith(LUME_AGENT_IDENTITY_LINE)).toBeTrue();
    expect(prompt).toContain("## Tooling");
    expect(prompt).not.toContain("Conversation Style");
  });

  test("buildSystemPromptAppend 在 citations=off 时应输出关闭提示", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-1",
      availableTools: ["memory.search", "memory.read"],
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
    expect(prompt).toContain("仅在以下情况才回退 WebSearch");
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

  test("内容生产仅在主对话和自动化最终回复中按信息密度启用 Infographic", () => {
    const direct = buildContentPresentationSection({ sessionId: "main", sessionType: "main", chatType: "direct" });
    const automation = buildContentPresentationSection({
      sessionId: "automation",
      sessionType: "main",
      chatType: "direct",
      automationExecution: true
    });

    expect(direct).toContain("不按篇幅长短机械触发");
    expect(direct).toContain("`lume-infographic` Skill");
    expect(direct).toContain("最多输出一个 `infographic`");
    expect(automation).toContain("自动化任务的最终结果");
    expect(buildContentPresentationSection({ sessionId: "plan", permissionMode: "plan" })).toBeNull();
    expect(buildContentPresentationSection({ sessionId: "sub", sessionType: "subagent" })).toBeNull();
    expect(buildContentPresentationSection({ sessionId: "group", chatType: "group" })).toBeNull();
    expect(buildContentPresentationSection({ sessionId: "channel", chatType: "channel" })).toBeNull();
  });

  test("buildSystemPromptAppend 应包含 loaded context policy", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-2",
      availableTools: []
    });
    expect(prompt).toContain("## Loaded Context Policy");
    expect(prompt).toContain("Use loaded workspace context and memory briefs first.");
    expect(prompt).toContain("Read deeper workspace, memory, or source files only when exact details are needed");
    expect(prompt).not.toContain("## Thread Bootstrap (Mandatory)");
    expect(prompt).not.toContain("workspace-files/.context/");
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
      availableTools: ["memory.search", "memory.read"],
      promptMode: "none"
    });
    expect(prompt.trim()).toBe(LUME_AGENT_IDENTITY_LINE);
  });

  test("buildSystemPromptAppend 在 promptMode=minimal 时应保留 Tooling/Workspace/Runtime", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-minimal",
      workspaceSlug: "demo-workspace",
      availableTools: ["memory.search", "memory.read"],
      promptMode: "minimal"
    });
    expect(prompt).toContain(LUME_AGENT_IDENTITY_LINE);
    expect(prompt).toContain("## Tooling");
    expect(prompt).toContain("Available tools are provided by the runtime tool schema");
    expect(prompt).not.toContain("- memory.search");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("System config entry: ~/.lume/lume.yaml");
    expect(prompt).not.toContain(".lume-config");
    expect(prompt).toContain("## Runtime");
    expect(prompt).not.toContain("## Agentic Execution");
    expect(prompt).not.toContain("## Delegation Policy");
    expect(prompt).not.toContain("## Thread Bootstrap (Mandatory)");
    expect(prompt).not.toContain("## Memory");
  });

  test("buildSystemPromptAppend 在 workspace 上下文中应仅声明真实系统配置路径", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "thread-xyz",
      workspaceName: "Demo",
      workspaceSlug: "demo",
      availableTools: ["read", "write"]
    });
    expect(prompt).toContain("- 系统配置入口: ~/.lume/lume.yaml");
    expect(prompt).not.toContain(".lume-config");
  });

  test("Tooling 段不应重复罗列 runtime 已提供的工具名", () => {
    const prompt = buildSystemPromptAppend({
      sessionId: "session-tool-order",
      promptMode: "minimal",
      availableTools: ["memory.read", "Write", "read", "AskUserQuestion", "memory.search", "write"]
    });

    expect(prompt).toContain("Tool names are case-sensitive");
    expect(prompt).not.toContain("- read");
    expect(prompt).not.toContain("- Write");
    expect(prompt).not.toContain("- AskUserQuestion");
    expect(prompt).not.toContain("- memory.search");
    expect(prompt).not.toContain("- memory.read");
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
      availableTools: ["Skill", "browser", "memory.search", "web_search", "read", "write"],
      userMessage: "help me create an execution plan"
    });

    expect(dynamic).toContain("<thread_state>");
    expect(dynamic).toContain("threadId: agent-session-1");
    expect(dynamic).toContain("title: Execution Planning");
    expect(dynamic).toContain("threadType: main");
    expect(dynamic).toContain("chatType: direct");
    expect(dynamic).toContain("parentThreadId: root-session");
    expect(dynamic).toContain("workspaceId: workspace-1");
    expect(dynamic).toContain("channelId: channel-1");
    expect(dynamic).toContain("modelId: claude-sonnet-4-5");
    expect(dynamic).toContain("<workspace_state>");
    expect(dynamic).toContain("Capability lanes: skills, browser, memory, web, raw-tools");
    expect(dynamic).toContain("Preferred capability route: skills");
    expect(dynamic).toContain("Capability routing reason:");
    expect(dynamic).toContain("Loaded Skills:");
    expect(dynamic).toContain("Use a loaded Skill only when it clearly matches the user's request");
    expect(dynamic).toContain("Only fall back to raw tool composition when no suitable Skill fits");
    expect(dynamic).toContain(`Skill call prefix: lume-workspace-${workspaceSlug}:`);
    expect(dynamic).toContain("- planner (Planner):");
    expect(dynamic).not.toContain(`lume-workspace-${workspaceSlug}:planner`);
    expect(dynamic).toContain("<working_directory>D:/workspace/projects/ai-projects/lume</working_directory>");
  });

  test("buildDynamicContext 应包含用户全局 skill 元数据", () => {
    const workspaceSlug = `prompt-user-skill-workspace-${Date.now()}`;
    const skillDir = join(getUserSkillsDir(), "global-planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        'name: "Global Planner"',
        'description: "Breaks work into execution plans"',
        "---",
        "",
        "# Global Planner",
        ""
      ].join("\n"),
      "utf-8"
    );

    const dynamic = buildDynamicContext({
      sessionId: "agent-session-global-skill",
      workspaceSlug,
      availableTools: ["Skill", "read", "write"],
      userMessage: "help me create an execution plan"
    });

    expect(dynamic).toContain("Preferred capability route: skills");
    expect(dynamic).toContain("- global-planner (Global Planner):");
  });

  test("buildDynamicContext 应包含启用插件摘要与插件 skill", () => {
    const dynamic = buildDynamicContext({
      sessionId: "agent-session-plugin-context",
      workspaceSlug: "plugin-workspace",
      availableTools: ["Skill", "read"],
      userMessage: "检查 Obsidian 连接",
      enabledPlugins: [{
        pluginId: "obsidian-bridge",
        displayName: "Obsidian Bridge",
        description: "Connect a local Obsidian vault.",
        skills: [{ name: "obsidian-bridge:vault-doctor", description: "Vault diagnostics" }],
        commandTools: [],
        mcpServers: ["obsidian-bridge:obsidian-bridge"],
        diagnostics: [],
      }]
    });

    expect(dynamic).toContain("Enabled Plugins:");
    expect(dynamic).toContain("obsidian-bridge (Obsidian Bridge)");
    expect(dynamic).toContain("obsidian-bridge:vault-doctor");
    expect(dynamic).toContain("mcp:obsidian-bridge:obsidian-bridge");
    expect(dynamic).not.toContain("$pluginId");
  });

  test("buildDynamicContext injects the same rooted file reference protocol for main and minimal subagents", () => {
    const roots = {
      projectRoot: "D:/work/demo",
      lumeWorkDir: "D:/lume/threads/thread-1",
    };
    for (const threadType of ["main", "subagent"] as const) {
      const dynamic = buildDynamicContext({
        sessionId: `file-ref-${threadType}`,
        sessionType: threadType,
        ...roots,
      });
      expect(dynamic).toContain("<file_reference_protocol>");
      expect(dynamic).toContain("项目根目录: D:/work/demo");
      expect(dynamic).toContain("会话文件上下文根目录: D:/lume/threads/thread-1");
      expect(dynamic).toContain("`@project/<relative-path>`");
      expect(dynamic).toContain("`@session/<relative-path>`");
      expect(dynamic).toContain("不要创建 Markdown 链接");
      expect(dynamic).toContain("不要引用这两个根目录之外的绝对路径");
    }
  });

  test("workspace context 应过滤空模板并默认跳过 heartbeat", () => {
    const workspaceSlug = `prompt-sanitized-workspace-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, "WORKSPACE.md"), "# WORKSPACE.md\n\n## Purpose\n\nPrompt runtime experiments.", "utf-8");
    writeFileSync(join(workspacePath, "USER.md"), "# USER.md\n\n- Name:\n- What to call them:\n- Pronouns:\n- Timezone:\n- Notes:\n", "utf-8");
    writeFileSync(join(workspacePath, "IDENTITY.md"), "# IDENTITY.md\n\n<!-- Describe Lume identity here -->\n", "utf-8");
    writeFileSync(join(workspacePath, "TOOLS.md"), "# TOOLS.md\n\n- Tool:\n- Notes:\n", "utf-8");
    writeFileSync(join(workspacePath, "HEARTBEAT.md"), "# HEARTBEAT.md\n\nPing the user every morning.", "utf-8");

    const prompt = buildSystemPromptAppend({
      sessionId: "session-sanitized-context",
      workspaceName: "Prompt Sanitized Workspace",
      workspaceSlug,
      chatType: "direct",
      availableTools: ["read"]
    });

    expect(prompt).toContain("## WORKSPACE.md");
    expect(prompt).toContain("Prompt runtime experiments.");
    expect(prompt).not.toContain("## USER.md");
    expect(prompt).not.toContain("- Name:");
    expect(prompt).not.toContain("## Persona Brief");
    expect(prompt).not.toContain("## TOOLS.md");
    expect(prompt).not.toContain("## HEARTBEAT.md");
    expect(prompt).not.toContain("Ping the user every morning.");
    expect(prompt).toContain("~/.lume/agent-workspaces/" + workspaceSlug + "/session-sanitized-context/");
    expect(prompt).toContain("Do not use or reveal runtime metadata as the user's identity");
  });

  test("brainstorming 与 loaded skills 应弱触发并压缩 manifest", () => {
    const workspaceSlug = `prompt-compact-skills-${Date.now()}`;
    const workspacePath = getAgentWorkspacePath(workspaceSlug);
    const skillDir = join(workspacePath, "skills", "brainstorming");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: brainstorming",
        "description: Use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent in a very long description that should not all be injected.",
        "---",
        "",
        "# Brainstorming"
      ].join("\n"),
      "utf-8"
    );

    const prompt = buildSystemPromptAppend({
      sessionId: "session-brainstorming-policy",
      workspaceSlug,
      availableTools: ["askuserquestion"]
    });
    const dynamic = buildDynamicContext({
      sessionId: "session-brainstorming-policy",
      workspaceSlug,
      availableTools: ["Skill"],
      userMessage: "critique this prompt"
    });

    expect(prompt).toContain("Use brainstorming only for ambiguous product/design exploration");
    expect(prompt).not.toContain("特别是在触发 brainstorming / 头脑风暴类 Skill 时，**必须**");
    expect(dynamic).toContain(`Skill call prefix: lume-workspace-${workspaceSlug}:`);
    expect(dynamic).toContain("- brainstorming:");
    expect(dynamic).toContain("ambiguous product/design exploration");
    expect(dynamic).not.toContain("Use this before any creative work");
  });
});
