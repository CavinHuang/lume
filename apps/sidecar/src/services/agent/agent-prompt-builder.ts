
import { getRuntimeSkills, getWorkspaceMcpConfig } from "./agent-workspace-manager";
import type { MemoryCitationsMode } from "../memory-v2/policy";
import { BUILTIN_AGENT_ROLES, canonicalizeAgentToolName } from "@lume/shared";
import type { AgentDefinition } from "@lume/agent-sdk";
import type { SessionType as ThreadType } from "@lume/shared";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { getAgentWorkspacePath, getAgentConfigDir } from "../infra/config-paths";
import { createLogger } from "../infra/logger";
import { renderSkillManifestLines } from "./prompt/context/skill-manifest-builder";
import { buildProjectInstructionsSection } from "./prompt/context/project-instructions";
import { buildMemorySections } from "./prompt/sections/memory-sections";
import {
  CLAUDE_PLAN_MODE_SECTION,
  buildExecutionPolicySections
} from "./prompt/sections/static-policy-sections";
import {
  buildBrowserFirstSection,
  buildPlanModeSection,
  buildUncertaintySection
} from "./prompt/sections/interaction-policy-sections";
import { buildToolingSection } from "./prompt/sections/tooling-section";
import { buildTodoSection } from "./prompt/sections/todo-section";
import { buildRuntimeSection as renderRuntimeSection } from "./prompt/sections/runtime-section";
import { buildWorkspaceContextSection } from "./prompt/sections/workspace-context-section";
import {
  buildAutomationSection,
  buildConversationStyleSection,
  buildLumeAgentSection,
  buildSafetySection,
  buildWorkspaceRulesSection
} from "./prompt/sections/core-sections";

export const LUME_AGENT_IDENTITY_LINE =
  "你是 Lume。你在这个本地优先的工作区里帮助用户思考、构建、整理并推进工作。";
export type SystemPromptMode = "full" | "minimal" | "none";
const log = createLogger("agent-prompt-builder");

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
      prompt: `你是 Lume 的软件架构师与规划专家。你的职责是探索代码库并设计实现方案。

=== 关键约束：只读模式——禁止任何文件修改 ===
这是只读规划任务。严禁：
- 创建任何新文件（禁止 Write、touch 或任何形式的文件创建）
- 修改既有文件（禁止 Edit 操作）
- 删除文件（禁止 rm 或删除）
- 移动或复制文件（禁止 mv 或 cp）
- 在任何位置创建临时文件（包括 /tmp）
- 使用重定向操作符（>、>>、|）或 heredoc 写文件
- 运行任何改变系统状态的命令
- 启动嵌套子代理
- 调用任何 Task 管理工具

你的职责 exclusively 是探索代码库并设计实现方案。你不审批计划、不管理 Task、不执行工作。主线程审阅你的提案并拥有执行权。

## 工作流程

1. 从调用方理解需求与约束。
2. 用 Read、Glob、Grep 与只读 Bash 命令（如 ls、git status、git log、git diff、find、grep、cat、head、tail）充分探索。
3. 设计遵循 Lume 既有模式的方案，并突出关键取舍。
4. 给出分步实现策略、依赖、顺序、风险与验证方式。

## Lume 计划交接

你的最终计划必须便于主线程通过正常 Task 与工具流程执行。不要宣称实现已完成。主线程拥有 Task 状态与执行。

以以下内容结尾：

### 实现所需关键文件
列出实现本计划最关键的 3-5 个文件：
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts`,
      tools: ["Read", "Glob", "Grep", "Bash"],
      disallowedTools: ["Agent", "Write", "Edit", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop"],
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
    for (const file of readdirSync(dir).sort((left, right) => left.localeCompare(right))) {
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

export interface SystemPromptContext {
  workspaceSlug?: string;
  /** agent 工作目录：用于向上探测项目级指令文件（CLAUDE.md/AGENTS.md） */
  agentCwd?: string;
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

export function buildContentPresentationSection(
  ctx: Pick<SystemPromptContext, "sessionType" | "chatType" | "sessionId" | "permissionMode" | "automationExecution">
): string | null {
  if (ctx.permissionMode === "plan") return null;
  if ((ctx.chatType ?? "direct") !== "direct") return null;
  if (resolveSessionType(ctx) !== "main") return null;

  const surface = ctx.automationExecution ? "自动化任务的最终结果" : "主对话的最终回复";
  // 表达形式的元规则（最小形式/按信息密度选择）由「## 表达策略」单点声明
  return `## 内容呈现

在${surface}中：
- 当多维对比、连续阶段、时间线、层级、关联网络、指标组合或分类概览用视觉布局能显著降低理解成本时，调用已加载的 \`lume-infographic\` Skill，并遵循其安全 DSL。
- “至少三个要点”只表示可以评估信息图，不构成强制触发；普通列表、表格或文字更清楚时不要生成。
- 信息图只能补充正文，不能替代必要解释；每次回复最多输出一个 \`infographic\` fenced code block。
- 不要在代码说明、纯叙述、翻译、单一结论、错误输出、工具结果或内部推理中生成信息图。
- Skill 不可用或没有合适模板时保持文字或表格，不要猜测 DSL。`;
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
    "## 工作区",
    "主工作区由 runtime context 提供。"
  );
  lines.push("会话管理文件由 runtime context 中的 Lume 工作目录提供。");
  lines.push("系统配置入口: ~/.lume/lume.yaml");

  lines.push("", buildRuntimeSection(ctx, "minimal"));

  const minimalProjectInstructions = buildProjectInstructionsSection(ctx.agentCwd);
  if (minimalProjectInstructions) {
    lines.push("", minimalProjectInstructions);
  }

  if (ctx.automationExecution) {
    lines.push(
      "",
      "## 自动化无交互模式",
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

  sections.push(buildLumeAgentSection());

  sections.push(buildToolingSection(ctx.availableTools).join("\n"));

  const workspaceRules = buildWorkspaceRulesSection(ctx.workspaceSlug);
  if (workspaceRules) {
    sections.push(workspaceRules);
  }

  sections.push(buildConversationStyleSection());

  const contentPresentationSection = buildContentPresentationSection(ctx);
  if (contentPresentationSection) {
    sections.push(contentPresentationSection);
  }

  sections.push(buildTodoSection());

  sections.push(...buildExecutionPolicySections());

  if (ctx.automationExecution) {
    sections.push(buildAutomationSection());
  }

  sections.push(buildUncertaintySection(ctx.permissionMode));

  // 计划模式增强
  if (ctx.permissionMode === "plan") {
    sections.push(buildPlanModeSection());
  }

  sections.push(buildSafetySection());

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
      log.warn("failed to read Soul/Memory prompt components", { error });
    }
  }

  // 项目级指令文件（CLAUDE.md/AGENTS.md，就近覆盖）：低频变更，进稳定 system
  // 前缀吃 prompt cache；无文件时不产生任何段落，prompt 保持原样
  const projectInstructions = buildProjectInstructionsSection(ctx.agentCwd);
  if (projectInstructions) {
    sections.push(projectInstructions);
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
  lumeWorkDir?: string;
  projectRoot?: string;
  availableTools?: string[];
  userMessage?: string;
  enabledPlugins?: EnabledPluginContextItem[];
}

export interface EnabledPluginContextItem {
  pluginId: string;
  displayName?: string;
  description?: string;
  skills: Array<{ name: string; description?: string }>;
  commandTools: string[];
  mcpServers: string[];
  diagnostics: string[];
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
  // title 与 modelRef/modelId 不注入：占位标题零信息，模型对自身 modelId 无可执行动作，
  // 反而诱发「用运行时元数据回答我是谁」的误用（见 ## 运行时 段告诫）
  if (ctx.sessionId) sessionLines.push(`threadId: ${ctx.sessionId}`);
  if (ctx.sessionType) sessionLines.push(`threadType: ${ctx.sessionType}`);
  if (ctx.chatType) sessionLines.push(`chatType: ${ctx.chatType}`);
  if (ctx.parentSessionId) sessionLines.push(`parentThreadId: ${ctx.parentSessionId}`);
  if (ctx.workspaceId) sessionLines.push(`workspaceId: ${ctx.workspaceId}`);
  if (ctx.channelId) sessionLines.push(`channelId: ${ctx.channelId}`);
  if (sessionLines.length > 0) {
    sections.push(`<thread_state>\n${sessionLines.join("\n")}\n</thread_state>`);
  }

  if (ctx.workspaceSlug) {
    const lines: string[] = [];
    if (ctx.workspaceName) {
      lines.push(`工作区: ${ctx.workspaceName}`);
    }
    const skills = getRuntimeSkills(ctx.workspaceSlug, ctx.agentCwd);

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

      if (skills.some((s) => s.slug === "skill-creator")) {
        lines.push("- 出现可复用的 Skill 改进模式时，用 skill-creator 做持久化修改");
      }
    }

    const pluginLines = renderEnabledPluginLines(ctx.enabledPlugins ?? []);
    if (pluginLines.length > 0) {
      lines.push(...pluginLines);
    }

    if (lines.length > 0) {
      sections.push(`<workspace_state>\n${lines.join("\n")}\n</workspace_state>`);
    }
  }

  if (ctx.agentCwd) {
    sections.push(`<working_directory>${ctx.agentCwd}</working_directory>`);
  }
  if (ctx.lumeWorkDir && ctx.lumeWorkDir !== ctx.agentCwd) {
    sections.push(`<lume_working_directory>${ctx.lumeWorkDir}</lume_working_directory>`);
  } else if (ctx.lumeWorkDir) {
    sections.push(`<lume_working_directory ordinary_session="true">${ctx.lumeWorkDir}</lume_working_directory>`);
  }

  if (ctx.projectRoot || ctx.lumeWorkDir) {
    // 两根目录的绝对路径已由上方 <working_directory>/<lume_working_directory> 给出，此处不再重复
    const lines = [
      "<file_reference_protocol>",
      "在主回复、子 Agent 回复和计划 Markdown 中引用本地文件时，只使用行内代码协议，不要创建 Markdown 链接。",
      ...(ctx.projectRoot ? [
        "项目根目录 = 上方 <working_directory>；根目录内的已知路径写作 `@project/<relative-path>`。"
      ] : []),
      ...(ctx.lumeWorkDir ? [
        "会话文件上下文根目录 = 上方 <lume_working_directory>；根目录内的已知路径写作 `@session/<relative-path>`。"
      ] : []),
      "路径使用 /，移除绝对根前缀；只引用确认位于对应根目录内的目标，不要引用根目录之外的绝对路径。",
      "文本或源码可追加 #L42 或 #L42-L48；目录引用以 / 结尾且不带行号。",
      "</file_reference_protocol>"
    ];
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

function compactPromptText(text?: string, maxLength = 120): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trim()}...` : normalized;
}

function renderEnabledPluginLines(plugins: EnabledPluginContextItem[]): string[] {
  if (plugins.length === 0) return [];
  const lines = [
    "已启用插件：",
  ];

  for (const plugin of plugins) {
    const label = plugin.displayName && plugin.displayName !== plugin.pluginId
      ? `${plugin.pluginId} (${plugin.displayName})`
      : plugin.pluginId;
    lines.push(`- ${label}: ${compactPromptText(plugin.description) || "已启用插件"}`);
    if (plugin.skills.length > 0) {
      lines.push(`  skills: ${plugin.skills.map((skill) => skill.name).join(", ")}`);
    }
    if (plugin.commandTools.length > 0 || plugin.mcpServers.length > 0) {
      const runtimeEntries = [
        ...plugin.commandTools,
        ...plugin.mcpServers.map((serverId) => `mcp:${serverId}`),
      ];
      lines.push(`  runtime: ${runtimeEntries.join(", ")}`);
    }
    // diagnostics 是插件健康状态，模型无法据此行动，不注入 prompt
  }

  return lines;
}
