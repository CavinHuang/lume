
import { getRuntimeSkills, getWorkspaceMcpConfig } from "./agent-workspace-manager";
import { inferCapabilityLanes, resolvePreferredCapabilityRoute } from "./capability-routing";
import type { MemoryCitationsMode } from "../memory-v2/policy";
import { BUILTIN_AGENT_ROLES, canonicalizeAgentToolName } from "@lume/shared";
import type { AgentDefinition } from "@lume/agent-sdk";
import type { SessionType as ThreadType } from "@lume/shared";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { getAgentWorkspacePath, getAgentConfigDir } from "../infra/config-paths";
import { renderSkillManifestLines } from "./prompt/context/skill-manifest-builder";
import { buildMemorySections } from "./prompt/sections/memory-sections";
import {
  CLAUDE_PLAN_MODE_SECTION,
  buildCapabilityPolicySections,
  buildExecutionPolicySections
} from "./prompt/sections/static-policy-sections";
import {
  buildBrowserFirstSection,
  buildPlanModeSection,
  buildUncertaintySection
} from "./prompt/sections/interaction-policy-sections";
import { buildToolingSection } from "./prompt/sections/tooling-section";
import { buildRuntimeSection as renderRuntimeSection } from "./prompt/sections/runtime-section";
import { buildWorkspaceContextSection } from "./prompt/sections/workspace-context-section";
import {
  buildAutomationSection,
  buildConversationStyleSection,
  buildKnowledgeMaintenanceSection,
  buildLumeAgentSection,
  buildSafetySection,
  buildSystemConfigSection,
  buildThreadBootstrapSection,
  buildWorkspaceRulesSection
} from "./prompt/sections/core-sections";

export const LUME_AGENT_IDENTITY_LINE =
  "You are Lume. You help the user think, build, organize, and move work forward in this local-first workspace.";
export type SystemPromptMode = "full" | "minimal" | "none";

const READ_ONLY_AGENT_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Skill"];
const RUNTIME_HANDWRITTEN_AGENT_IDS = new Set<string>(["explorer", "planner", "code-reviewer"]);

/**
 * 内置 SubAgent 定义。
 * 这些定义会在 runtime session 创建时注册到 SDK 的 Agent 工具中，
 * 让主线程可以直接按名称调用 explorer / planner / researcher / code-reviewer。
 */
export function buildBuiltinAgents(): Record<string, AgentDefinition> {
  const lumeBuiltins: Record<string, AgentDefinition> = {
    explorer: {
      description: "代码库探索子代理。快速搜索文件、理解项目结构、收集相关上下文，适合在修改前先摸清代码。",
      defaultSkillName: "agent-explorer",
      prompt: `你是一个高效的代码库探索员。你的职责是快速搜索和收集信息，然后返回结构化结果。

工作方式：
- 优先并行使用 Glob、Grep、Read 与 Bash 收集上下文
- 返回信息时包含具体文件路径、关键函数/类型、依赖关系与相关模式
- 保持简洁，只输出与当前任务直接相关的信息
- 不直接做代码修改，除非上级任务明确要求你执行修改

输出应尽量结构化，方便主线程直接整合。`,
      tools: ["Read", "Glob", "Grep", "Bash"],
      model: "inherit"
    },
    planner: {
      description: "只读计划子代理。用于设计实现方案、识别关键文件和权衡架构取舍。",
      defaultSkillName: "agent-planner",
      prompt: `You are a software architect and planning specialist for Lume. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state
- Launching nested agents
- Calling TaskContractWrite or TaskReport

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT approve plans and you do NOT submit task contracts. The main thread owns TaskContractWrite and plan approval.

## Your Process

1. Understand requirements and constraints from the caller.
2. Explore thoroughly with Read, Glob, Grep, and read-only Bash commands such as ls, git status, git log, git diff, find, grep, cat, head, and tail.
3. Design a solution that follows existing Lume patterns and highlights important trade-offs.
4. Detail a step-by-step implementation strategy, dependencies, sequencing, risks, and verification.

## Lume Plan Handoff

Your final plan must be easy for the main thread to convert into TaskContractWrite planMarkdown and steps. Do not claim implementation is complete. The main thread owns TaskContractWrite, review, and execution after approval.

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts`,
      tools: ["Read", "Glob", "Grep", "Bash"],
      disallowedTools: ["Agent", "Write", "Edit", "TaskContractWrite", "TaskReport"],
      model: "inherit"
    },
    researcher: {
      description: "技术调研子代理。用于方案对比、依赖评估和架构分析，输出结构化结论与风险提示。",
      defaultSkillName: "agent-researcher",
      prompt: `你是一个技术调研员。你的职责是围绕特定技术问题收集信息并输出结构化分析。

输出格式：
- 问题概述：一句话说明调研目标
- 方案对比：用清晰结构比较候选方案的优劣
- 推荐方案：明确给出推荐及理由
- 风险提示：说明潜在问题、边界条件和实施注意事项
- 参考来源：列出代码中的相关实现或外部资料线索

保持客观，不要空泛表态。`,
      tools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
      model: "inherit"
    },
    "code-reviewer": {
      description: "代码审查子代理。用于在变更完成后复核逻辑、边界、命名与规范一致性。",
      defaultSkillName: "agent-code-reviewer",
      prompt: `你是一个专注于代码质量的审查员。你的职责是审查变更结果并指出真实风险。

审查重点：
- 逻辑错误、边界条件与潜在回归
- 命名是否清晰、一致、贴近领域语义
- 是否存在重复实现、额外复杂度或可复用遗漏
- 是否符合项目规范与已知架构边界

输出要求：
- 按严重程度组织结果
- 每条意见尽量附带具体文件路径和定位信息
- 若未发现问题，直接说明“审查通过，无需修改”

保持客观、具体，不要泛泛而谈。`,
      tools: ["Read", "Glob", "Grep", "Bash"],
      model: "inherit"
    }
  };

  return {
    ...lumeBuiltins,
    ...Object.fromEntries(BUILTIN_AGENT_ROLES
      .filter((role) => !RUNTIME_HANDWRITTEN_AGENT_IDS.has(role.id))
      .map((role) => [
        role.id,
        {
          description: `${role.title}。${role.description}`,
          defaultSkillName: role.defaultSkillName,
          prompt: [
            role.systemPrompt,
            "",
            `默认 Skill: ${role.defaultSkillName}`,
            "如果该 Skill 已加载且适合当前任务，优先调用 Skill 工具使用它。",
            "角色设定不能覆盖 Lume 的权限、安全、隐私和用户确认规则。"
          ].join("\n"),
          ...(role.concurrency.defaultReadOnly ? { tools: READ_ONLY_AGENT_TOOLS } : { disallowedTools: ["Agent"] }),
          model: "inherit"
        } satisfies AgentDefinition
      ]))
  };
}

function parseAgentFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const body = match[2]!.trim();
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      frontmatter[key] = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (!Number.isNaN(Number(val))) {
      frontmatter[key] = Number(val);
    } else {
      frontmatter[key] = val;
    }
  }
  return { frontmatter, body };
}

export function loadCustomAgents(workspaceSlug?: string): Record<string, AgentDefinition> {
  const dirs: string[] = [join(getAgentConfigDir(), "agents")];
  if (workspaceSlug) {
    try {
      dirs.push(join(getAgentWorkspacePath(workspaceSlug), ".lume", "agents"));
    } catch {
      // invalid slug, skip
    }
  }
  const result: Record<string, AgentDefinition> = {};
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = readFileSync(join(dir, file), "utf-8");
        const { frontmatter, body } = parseAgentFrontmatter(content);
        const id = basename(file, ".md");
        result[id] = {
          description: typeof frontmatter.description === "string" ? frontmatter.description : id,
          prompt: body,
          tools: Array.isArray(frontmatter.tools) ? frontmatter.tools as string[] : undefined,
          model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
          maxTurns: typeof frontmatter.maxTurns === "number" ? frontmatter.maxTurns : undefined
        };
      } catch {
        // skip malformed files
      }
    }
  }
  return result;
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";

interface SystemPromptContext {
  workspaceName?: string;
  workspaceSlug?: string;
  sessionId: string;
  sessionType?: ThreadType;
  chatType?: "direct" | "group" | "channel";
  availableTools?: string[];
  memoryCitationsMode?: MemoryCitationsMode;
  promptMode?: SystemPromptMode;
  automationExecution?: boolean;
  permissionMode?: PermissionMode;
}

export function shouldLoadLongTermMemory(chatType?: "direct" | "group" | "channel"): boolean {
  return (chatType ?? "direct") === "direct";
}

function inferSessionType(ctx: Pick<SystemPromptContext, "chatType" | "sessionId">): ThreadType {
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

function resolveSessionType(ctx: Pick<SystemPromptContext, "sessionType" | "chatType" | "sessionId">): ThreadType {
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
  lines.push("System config entry: ~/.lume/lume.yaml");

  lines.push("", buildRuntimeSection(ctx, "minimal"));
  if (ctx.automationExecution) {
    lines.push(
      "",
      "## Automation Non-Interactive Mode",
      "当前由定时任务触发，禁止用户交互。",
      "- 不要调用 AskUserQuestion",
      "- 不要等待权限确认或人工输入",
      "- 若任务需要交互，请立即失败并返回结构化错误，说明需要改为无交互流程"
    );
  }
  lines.push("", CLAUDE_PLAN_MODE_SECTION);

  return lines;
}

function buildRuntimeSection(ctx: SystemPromptContext, promptMode: SystemPromptMode): string {
  return renderRuntimeSection({
    promptMode,
    sessionType: resolveSessionType(ctx),
    chatType: ctx.chatType
  });
}

export function buildSystemPromptAppend(ctx: SystemPromptContext): string {
  const promptMode = resolveSystemPromptMode(ctx);
  const sections: string[] = [LUME_AGENT_IDENTITY_LINE];

  if (promptMode === "none") {
    return sections.join("\n");
  }

  if (promptMode === "minimal") {
    sections.push(...buildMinimalSections(ctx));
    return sections.join("\n\n");
  }

  sections.push(buildLumeAgentSection(ctx));

  sections.push(buildToolingSection(ctx.availableTools).join("\n"));

  sections.push(buildSystemConfigSection());

  if (ctx.workspaceName && ctx.workspaceSlug) {
    const workspaceRules = buildWorkspaceRulesSection(ctx);
    if (workspaceRules) {
      sections.push(workspaceRules);
    }
  }

  sections.push(buildKnowledgeMaintenanceSection());
  sections.push(buildConversationStyleSection());

  sections.push(
    ...buildExecutionPolicySections(),
    ...buildCapabilityPolicySections()
  );

  if (ctx.automationExecution) {
    sections.push(buildAutomationSection());
  }

  sections.push(buildUncertaintySection(ctx.permissionMode));

  // 计划模式增强
  if (ctx.permissionMode === "plan") {
    sections.push(buildPlanModeSection());
  }

  sections.push(buildSafetySection());

  sections.push(buildThreadBootstrapSection());

  const availableTools = new Set((ctx.availableTools ?? []).map((item) => canonicalizeAgentToolName(item)));
  const browserFirstSection = buildBrowserFirstSection(availableTools);
  if (browserFirstSection) {
    sections.push(browserFirstSection);
  }

  sections.push(...buildMemorySections({
    availableTools,
    citationsMode: ctx.memoryCitationsMode
  }));

  // 注入工作区上下文（OpenClaw 风格）
  if (ctx.workspaceSlug) {
    try {
      const projectContext = buildWorkspaceContextSection({
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

export interface DynamicContext {
  sessionId?: string;
  sessionTitle?: string;
  sessionType?: ThreadType;
  chatType?: "direct" | "group" | "channel";
  parentSessionId?: string;
  workspaceId?: string;
  channelId?: string;
  modelRef?: string;
  modelId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  agentCwd?: string;
  availableTools?: string[];
  userMessage?: string;
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

  const sessionLines: string[] = [];
  if (ctx.sessionId) sessionLines.push(`threadId: ${ctx.sessionId}`);
  if (ctx.sessionTitle) sessionLines.push(`title: ${ctx.sessionTitle}`);
  if (ctx.sessionType) sessionLines.push(`threadType: ${ctx.sessionType}`);
  if (ctx.chatType) sessionLines.push(`chatType: ${ctx.chatType}`);
  if (ctx.parentSessionId) sessionLines.push(`parentThreadId: ${ctx.parentSessionId}`);
  if (ctx.workspaceId) sessionLines.push(`workspaceId: ${ctx.workspaceId}`);
  if (ctx.channelId) sessionLines.push(`channelId: ${ctx.channelId}`);
  if (ctx.modelRef) sessionLines.push(`modelRef: ${ctx.modelRef}`);
  if (ctx.modelId) sessionLines.push(`modelId: ${ctx.modelId}`);
  if (sessionLines.length > 0) {
    sections.push(`<thread_state>\n${sessionLines.join("\n")}\n</thread_state>`);
  }

  if (ctx.workspaceSlug) {
    const lines: string[] = [];
    if (ctx.workspaceName) {
      lines.push(`工作区: ${ctx.workspaceName}`);
    }
    const capabilityLanes = inferCapabilityLanes(ctx.availableTools);
    if (capabilityLanes.length > 0) {
      lines.push(`Capability lanes: ${capabilityLanes.join(", ")}`);
    }

    const skills = getRuntimeSkills(ctx.workspaceSlug, ctx.agentCwd);
    const preferredRoute = resolvePreferredCapabilityRoute({
      userMessage: ctx.userMessage,
      availableTools: ctx.availableTools,
      loadedSkills: skills
    });
    if (preferredRoute.preferredLane) {
      lines.push(`Preferred capability route: ${preferredRoute.preferredLane}`);
    }
    lines.push(`Capability routing reason: ${preferredRoute.reason}`);

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

    if (skills.length > 0) {
      lines.push(...renderSkillManifestLines({
        workspaceSlug: ctx.workspaceSlug,
        skills
      }));

      const hasSkillCreator = skills.some((s) => s.slug === "skill-creator");
      if (hasSkillCreator) {
        lines.push("");
        lines.push("<skill_improvement_hint>");
        lines.push("skill-creator is available for durable skill changes. Mention it only when a reusable improvement pattern is clear.");
        lines.push("</skill_improvement_hint>");
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
