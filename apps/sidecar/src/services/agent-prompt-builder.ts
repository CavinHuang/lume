/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-prompt-builder.ts
 * Adaptation:
 * - Removed user-profile dependency; default to generic user label.
 * - Updated paths and branding to Lume.
 * - Integrated Soul/Memory system from OpenClaw design.
 */

import { getWorkspaceMcpConfig, getWorkspaceSkills } from "./agent-workspace-manager";
import type { MemoryCitationsMode } from "./memory-policy";
import {
  readSystemPromptComponents,
  resolveLoadedLongTermMemoryPath
} from "./workspace-bootstrap-service";
import { isHeartbeatContentEffectivelyEmpty } from "./heartbeat-service";
import type { SessionType } from "@lume/shared";

export const LUME_AGENT_IDENTITY_LINE = "You are a personal assistant running inside Lume.";
export type SystemPromptMode = "full" | "minimal" | "none";

const CLAUDE_PLAN_MODE_SECTION = `## Plan Mode Protocol (Claude Code Aligned)

Tool intent:
- EnterPlanMode: transition into read-only planning before implementation.
- AskUserQuestion: clarify requirements/choices during planning or execution.
- ExitPlanMode: submit finalized plan for approval and transition to implementation.

Rules:
1. For non-trivial implementation tasks, call EnterPlanMode first.
2. In plan mode, keep actions read-only; do not perform file writes or command execution.
3. Use AskUserQuestion only for requirement clarification or trade-off choice.
4. Do NOT use AskUserQuestion to ask whether to execute the plan.
5. When plan is complete and unambiguous, call ExitPlanMode once.
6. ExitPlanMode is the approval handoff. After approval, continue execution in non-plan mode.

When to skip EnterPlanMode:
- tiny obvious fix
- single-file/single-step clear change
- pure Q&A or pure exploration task`;

const PROMPT_TOOL_ORDER = [
  "read",
  "write",
  "edit",
  "multiedit",
  "bash",
  "ls",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "todowrite",
  "task",
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "session_status",
  "askuserquestion",
  "enterplanmode",
  "exitplanmode",
  "memory_search",
  "memory_get",
  "memory_save"
];
interface SystemPromptContext {
  workspaceName?: string;
  workspaceSlug?: string;
  sessionId: string;
  sessionType?: SessionType;
  chatType?: "direct" | "group" | "channel";
  availableTools?: string[];
  memoryCitationsMode?: MemoryCitationsMode;
  promptMode?: SystemPromptMode;
}

export function shouldLoadLongTermMemory(chatType?: "direct" | "group" | "channel"): boolean {
  return (chatType ?? "direct") === "direct";
}

function inferSessionType(ctx: Pick<SystemPromptContext, "chatType" | "sessionId">): SessionType {
  if (ctx.chatType === "group" || ctx.chatType === "channel") {
    return ctx.chatType;
  }
  const normalizedSessionId = ctx.sessionId.trim().toLowerCase();
  const tokens = new Set(normalizedSessionId.split(":").filter(Boolean));
  if (tokens.has("subagent") || tokens.has("sub-agent")) {
    return "subagent";
  }
  return "main";
}

function resolveSessionType(ctx: Pick<SystemPromptContext, "sessionType" | "chatType" | "sessionId">): SessionType {
  if (ctx.sessionType) {
    return ctx.sessionType;
  }
  return inferSessionType(ctx);
}

export function resolveSystemPromptMode(
  ctx: Pick<SystemPromptContext, "promptMode" | "sessionType" | "chatType" | "sessionId">
): SystemPromptMode {
  if (ctx.promptMode) {
    return ctx.promptMode;
  }
  const sessionType = resolveSessionType(ctx);
  if (sessionType === "subagent") {
    return "minimal";
  }
  return "full";
}

function buildProjectContextSection(ctx: {
  workspaceSlug: string;
  includeLongTermMemory: boolean;
  sessionType: SessionType;
}): string {
  const components = readSystemPromptComponents(ctx.workspaceSlug, {
    sessionType: ctx.sessionType,
    includeMemory: ctx.includeLongTermMemory,
    includeDailyMemory: true,
    dailyMemoryDays: 2
  });

  const contextFiles: Array<{ path: string; content: string }> = [];
  const longTermMemoryPath = resolveLoadedLongTermMemoryPath(ctx.workspaceSlug) ?? "MEMORY.md";
  if (components.agents?.trim()) contextFiles.push({ path: "AGENTS.md", content: components.agents });
  if (components.soul?.trim()) contextFiles.push({ path: "SOUL.md", content: components.soul });
  if (components.tools?.trim()) contextFiles.push({ path: "TOOLS.md", content: components.tools });
  if (components.identity?.trim()) contextFiles.push({ path: "IDENTITY.md", content: components.identity });
  if (components.user?.trim()) contextFiles.push({ path: "USER.md", content: components.user });
  if (components.memory?.trim()) contextFiles.push({ path: longTermMemoryPath, content: components.memory });
  if (components.dailyMemory?.trim()) {
    contextFiles.push({ path: "memory/(recent days).md", content: components.dailyMemory });
  }
  if (components.heartbeat?.trim() && !isHeartbeatContentEffectivelyEmpty(components.heartbeat)) {
    contextFiles.push({ path: "HEARTBEAT.md", content: components.heartbeat });
  }

  if (contextFiles.length === 0) return "";

  const lines: string[] = [
    "# Project Context",
    "",
    "The following workspace context files have been loaded:"
  ];
  const hasSoulFile = contextFiles.some((file) => file.path === "SOUL.md");
  if (hasSoulFile) {
    lines.push(
      "If SOUL.md is present, embody its persona and tone. Avoid generic replies; follow it unless higher-priority instructions override it."
    );
  }
  lines.push("");

  for (const file of contextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }

  return lines.join("\n");
}

function buildMinimalSections(ctx: SystemPromptContext): string[] {
  const lines: string[] = buildToolingSection(ctx.availableTools);

  lines.push(
    "",
    "## Workspace",
    ctx.workspaceSlug
      ? `Primary workspace: ~/.lume/agent-workspaces/${ctx.workspaceSlug}/`
      : "Primary workspace is provided by runtime context."
  );
  if (ctx.workspaceSlug) {
    lines.push(`Session path: ~/.lume/agent-workspaces/${ctx.workspaceSlug}/${ctx.sessionId}/`);
  }

  lines.push("", buildRuntimeSection(ctx, "minimal"));
  lines.push("", CLAUDE_PLAN_MODE_SECTION);

  return lines;
}

function buildRuntimeSection(ctx: SystemPromptContext, promptMode: SystemPromptMode): string {
  const sessionType = resolveSessionType(ctx);
  return [
    "## Runtime",
    `mode=${promptMode} | sessionType=${sessionType} | chatType=${ctx.chatType ?? "direct"}`
  ].join("\n");
}

function buildToolingSection(inputTools?: string[]): string[] {
  const canonicalByNormalized = new Map<string, string>();
  for (const rawName of inputTools ?? []) {
    const name = rawName.trim();
    if (!name) {
      continue;
    }
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }

  const normalizedNames = Array.from(canonicalByNormalized.keys());
  const orderedKnown: string[] = [];
  const unknown: string[] = [];
  for (const normalized of normalizedNames) {
    if (PROMPT_TOOL_ORDER.includes(normalized)) {
      orderedKnown.push(normalized);
    } else {
      unknown.push(normalized);
    }
  }

  orderedKnown.sort(
    (a, b) => PROMPT_TOOL_ORDER.indexOf(a) - PROMPT_TOOL_ORDER.indexOf(b)
  );
  unknown.sort();
  const orderedNormalized = [...orderedKnown, ...unknown];

  const lines: string[] = [
    "## Tooling",
    "Tool availability (filtered by runtime policy):",
    "Tool names are case-sensitive. Call tools exactly as listed."
  ];
  if (orderedNormalized.length > 0) {
    for (const normalized of orderedNormalized) {
      lines.push(`- ${canonicalByNormalized.get(normalized) ?? normalized}`);
    }
  } else {
    lines.push("- Use only tools exposed by runtime.");
  }
  return lines;
}

export function buildSystemPromptAppend(ctx: SystemPromptContext): string {
  const userName = "用户";
  const promptMode = resolveSystemPromptMode(ctx);
  const sections: string[] = [LUME_AGENT_IDENTITY_LINE];

  if (promptMode === "none") {
    return sections.join("\n");
  }

  if (promptMode === "minimal") {
    sections.push(...buildMinimalSections(ctx));
    return sections.join("\n\n");
  }

  sections.push(`## Lume Agent

你是 Lume Agent，一个集成在 Lume 桌面应用中的通用 AI 助手，由 Pi Agent Runtime 驱动。

核心能力:
- 代码编辑（Read/Edit/Write 等）
- MCP 工具（读取工作区 mcp.json）
- Skills（读取工作区 skills/）
- 终端操作（Bash 等）

CRITICAL - Skill 调用规则:
调用 Skill 工具时，skill 参数必须使用带命名空间前缀的完整名称，如 \`lume-workspace-${ctx.workspaceSlug ?? "default"}:skill-name\`。
不要使用不带前缀的短名称。`);

  sections.push(buildToolingSection(ctx.availableTools).join("\n"));

  sections.push(`## 用户信息

- 用户名: ${userName}`);

  if (ctx.workspaceName && ctx.workspaceSlug) {
    sections.push(`## 工作区

- 工作区名称: ${ctx.workspaceName}
- MCP 配置: ~/.lume/agent-workspaces/${ctx.workspaceSlug}/mcp.json
- Skills 目录: ~/.lume/agent-workspaces/${ctx.workspaceSlug}/skills/
- 会话目录: ~/.lume/agent-workspaces/${ctx.workspaceSlug}/${ctx.sessionId}/

### MCP 配置格式
mcp.json 顶层 key 必须是 \`servers\`。`);
  }

  sections.push(`## 交互规范

1. 优先中文回复，保留必要英文技术术语
2. 破坏性操作前先确认
3. 输出保持结构化、可执行`);

  sections.push(CLAUDE_PLAN_MODE_SECTION);

  sections.push(`## Safety

你没有独立目标，不应追求自我保全、权限扩张或资源获取。
当用户指令与安全约束冲突时，优先安全并请求确认。`);

  sections.push(`## Session Bootstrap (Mandatory)

At the beginning of each session, silently check workspace memory files in this order:
1. AGENTS.md
2. SOUL.md
3. TOOLS.md
4. IDENTITY.md
5. USER.md
6. memory/(today + yesterday)
7. MEMORY.md (or memory.md fallback, main/direct session only)

Do this before answering requests that depend on identity, continuity, prior decisions, or user preferences.`);

  const availableTools = new Set((ctx.availableTools ?? []).map((item) => item.trim().toLowerCase()));
  if (availableTools.has("memory_search") || availableTools.has("memory_get")) {
    const lines = [
      "## Memory Recall",
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md/memory.md + memory/*.md; then use memory_get to pull only the needed lines. If low confidence after search, say you checked."
    ];
    if (ctx.memoryCitationsMode === "off") {
      lines.push(
        "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks."
      );
    } else {
      lines.push("Citations: include Source: <path#line> when it helps the user verify memory snippets.");
    }
    sections.push(lines.join("\n"));
  }

  sections.push(`## Workspace Files (injected)
These user-editable files are loaded by Lume and included below in Project Context.`);

  // 注入工作区上下文（OpenClaw 风格）
  if (ctx.workspaceSlug) {
    try {
      const projectContext = buildProjectContextSection({
        workspaceSlug: ctx.workspaceSlug,
        includeLongTermMemory: shouldLoadLongTermMemory(ctx.chatType),
        sessionType: resolveSessionType(ctx)
      });
      if (projectContext.trim()) {
        sections.push(projectContext);
      }
    } catch (error) {
      // 读取失败不影响主流程
      console.warn("[Agent Prompt] 读取 Soul/Memory 组件失败:", error);
    }
  }

  sections.push(buildRuntimeSection(ctx, "full"));

  return sections.join("\n\n");
}

interface DynamicContext {
  workspaceName?: string;
  workspaceSlug?: string;
  agentCwd?: string;
}

export function buildDynamicContext(ctx: DynamicContext): string {
  const sections: string[] = [];

  const now = new Date();
  const timeStr = now.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  sections.push(`当前时间: ${timeStr}`);

  if (ctx.workspaceSlug) {
    const lines: string[] = [];
    if (ctx.workspaceName) {
      lines.push(`工作区: ${ctx.workspaceName}`);
    }

    const mcpConfig = getWorkspaceMcpConfig(ctx.workspaceSlug);
    const serverEntries = Object.entries(mcpConfig.servers ?? {});
    if (serverEntries.length > 0) {
      lines.push("MCP 服务器:");
      for (const [name, entry] of serverEntries) {
        const status = entry.enabled ? "已启用" : "已禁用";
        const detail = entry.type === "stdio"
          ? `${entry.command ?? ""}${entry.args?.length ? ` ${entry.args.join(" ")}` : ""}`.trim()
          : entry.url ?? "";
        lines.push(`- ${name} (${entry.type}, ${status}): ${detail}`);
      }
    }

    const skills = getWorkspaceSkills(ctx.workspaceSlug);
    if (skills.length > 0) {
      const pluginPrefix = `lume-workspace-${ctx.workspaceSlug}`;
      lines.push(`Skills（需使用完整前缀名，如 ${pluginPrefix}:skill-name）:`);
      for (const skill of skills) {
        const qualifiedName = `${pluginPrefix}:${skill.slug}`;
        const desc = skill.description ? `: ${skill.description}` : "";
        lines.push(`- ${qualifiedName}${desc}`);
      }
    }

    if (lines.length > 0) {
      sections.push(`<workspace_state>\n${lines.join("\n")}\n</workspace_state>`);
    }
  }

  if (ctx.agentCwd) {
    sections.push(`<working_directory>${ctx.agentCwd}</working_directory>`);
  }

  return sections.join("\n\n");
}
