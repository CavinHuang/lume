/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-prompt-builder.ts
 * Adaptation:
 * - Removed user-profile dependency; default to generic user label.
 * - Updated paths and branding to Lume.
 */

import { getWorkspaceMcpConfig, getWorkspaceSkills } from "./agent-workspace-manager";

interface SystemPromptContext {
  workspaceName?: string;
  workspaceSlug?: string;
  sessionId: string;
}

export function buildSystemPromptAppend(ctx: SystemPromptContext): string {
  const userName = "用户";
  const sections: string[] = [];

  sections.push(`## Lume Agent

你是 Lume Agent，一个集成在 Lume 桌面应用中的通用 AI 助手，由 Claude Agent SDK 驱动。

核心能力:
- 代码编辑（Read/Edit/Write 等）
- MCP 工具（读取工作区 mcp.json）
- Skills（读取工作区 skills/）
- 终端操作（Bash 等）

CRITICAL - Skill 调用规则:
调用 Skill 工具时，skill 参数必须使用带命名空间前缀的完整名称，如 \`lume-workspace-${ctx.workspaceSlug ?? "default"}:skill-name\`。
不要使用不带前缀的短名称。`);

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
