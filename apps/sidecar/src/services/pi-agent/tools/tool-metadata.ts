import type { AgentToolPermissionRiskLevel } from "@lume/shared";

/**
 * 工具类别
 * - read: 只读操作（读取文件、搜索等）
 * - write: 写入操作（创建、修改文件等）
 * - execute: 执行操作（运行命令、启动进程等）
 * - control: 控制操作（模式切换、用户交互等）
 * - network: 网络操作（HTTP 请求等）
 */
export type ToolCategory = "read" | "write" | "execute" | "control" | "network";

/**
 * 工具元数据
 */
export interface ToolMetadata {
  /** 工具名称 */
  name: string;
  /** 工具类别 */
  category: ToolCategory;
  /** 风险等级 */
  riskLevel: AgentToolPermissionRiskLevel;
  /** 简短描述 */
  description?: string;
  /** 是否在 Plan 模式下允许 */
  allowedInPlanMode?: boolean;
}

/**
 * 工具注册表
 */
const TOOL_METADATA_REGISTRY: Map<string, ToolMetadata> = new Map();

/**
 * 注册工具元数据
 */
export function registerToolMetadata(metadata: ToolMetadata): void {
  TOOL_METADATA_REGISTRY.set(metadata.name.toLowerCase(), {
    ...metadata,
    allowedInPlanMode: metadata.allowedInPlanMode ?? isCategoryAllowedInPlanMode(metadata.category)
  });
}

/**
 * 获取工具元数据
 */
export function getToolMetadata(toolName: string): ToolMetadata | undefined {
  return TOOL_METADATA_REGISTRY.get(toolName.toLowerCase());
}

/**
 * 获取所有工具元数据
 */
export function getAllToolMetadata(): ToolMetadata[] {
  return Array.from(TOOL_METADATA_REGISTRY.values());
}

/**
 * 判断类别是否在 Plan 模式下允许
 */
function isCategoryAllowedInPlanMode(category: ToolCategory): boolean {
  return category === "read" || category === "control";
}

/**
 * Plan 模式规则
 */
export const PLAN_MODE_RULES = {
  /** 允许的类别 */
  allowedCategories: ["read", "control"] as ToolCategory[],
  /** 禁止的类别 */
  blockedCategories: ["write", "execute", "network"] as ToolCategory[]
};

/**
 * 检查工具是否在 Plan 模式下允许
 */
export function isToolAllowedInPlanMode(toolName: string): boolean {
  const metadata = getToolMetadata(toolName);
  if (metadata) {
    return metadata.allowedInPlanMode ?? false;
  }
  // 如果没有注册元数据，使用默认规则
  return false;
}

/**
 * 根据工具名称推断元数据（用于未注册的工具）
 */
export function inferToolMetadata(toolName: string): ToolMetadata {
  const existing = getToolMetadata(toolName);
  if (existing) return existing;

  const normalized = toolName.toLowerCase();

  // 根据名称推断类别和风险
  let category: ToolCategory = "read";
  let riskLevel: AgentToolPermissionRiskLevel = "low";

  if (normalized === "bash" || normalized === "exec" || normalized === "process") {
    category = "execute";
    riskLevel = "high";
  } else if (
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "multiedit"
  ) {
    category = "write";
    riskLevel = "medium";
  } else if (
    normalized.includes("save") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    category = "write";
    riskLevel = "medium";
  } else if (
    normalized.includes("send") ||
    normalized.includes("spawn") ||
    normalized.includes("execute")
  ) {
    category = "execute";
    riskLevel = "medium";
  } else if (
    normalized.includes("fetch") ||
    normalized.includes("search") ||
    normalized.includes("request")
  ) {
    category = "network";
    riskLevel = "low";
  } else if (
    normalized.startsWith("session") ||
    normalized.startsWith("agent")
  ) {
    category = "control";
    riskLevel = "low";
  }

  return {
    name: toolName,
    category,
    riskLevel,
    allowedInPlanMode: isCategoryAllowedInPlanMode(category)
  };
}

// ============ 注册内置工具元数据 ============

// 基础工具
registerToolMetadata({
  name: "read",
  category: "read",
  riskLevel: "low",
  description: "读取文件内容"
});

registerToolMetadata({
  name: "write",
  category: "write",
  riskLevel: "medium",
  description: "创建或覆盖文件"
});

registerToolMetadata({
  name: "edit",
  category: "write",
  riskLevel: "medium",
  description: "编辑文件内容"
});

registerToolMetadata({
  name: "MultiEdit",
  category: "write",
  riskLevel: "medium",
  description: "批量编辑多个文件"
});

registerToolMetadata({
  name: "bash",
  category: "execute",
  riskLevel: "high",
  description: "执行 Shell 命令"
});

registerToolMetadata({
  name: "find",
  category: "read",
  riskLevel: "low",
  description: "按模式搜索文件"
});

registerToolMetadata({
  name: "grep",
  category: "read",
  riskLevel: "low",
  description: "在文件中搜索文本"
});

registerToolMetadata({
  name: "ls",
  category: "read",
  riskLevel: "low",
  description: "列出目录内容"
});

// 控制工具
registerToolMetadata({
  name: "AskUserQuestion",
  category: "control",
  riskLevel: "low",
  description: "向用户提问"
});

registerToolMetadata({
  name: "EnterPlanMode",
  category: "control",
  riskLevel: "low",
  description: "进入计划模式",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "ExitPlanMode",
  category: "control",
  riskLevel: "low",
  description: "退出计划模式",
  allowedInPlanMode: true
});

// 记忆工具
registerToolMetadata({
  name: "memory_search",
  category: "read",
  riskLevel: "low",
  description: "搜索记忆内容"
});

registerToolMetadata({
  name: "memory_get",
  category: "read",
  riskLevel: "low",
  description: "获取记忆内容"
});

registerToolMetadata({
  name: "memory_save",
  category: "write",
  riskLevel: "medium",
  description: "保存记忆内容"
});

// 会话工具
registerToolMetadata({
  name: "agents_list",
  category: "control",
  riskLevel: "low",
  description: "列出所有 Agent"
});

registerToolMetadata({
  name: "sessions_list",
  category: "control",
  riskLevel: "low",
  description: "列出所有会话"
});

registerToolMetadata({
  name: "sessions_history",
  category: "read",
  riskLevel: "low",
  description: "获取会话历史"
});

registerToolMetadata({
  name: "sessions_send",
  category: "execute",
  riskLevel: "medium",
  description: "发送消息到会话"
});

registerToolMetadata({
  name: "sessions_delete",
  category: "write",
  riskLevel: "medium",
  description: "删除会话及其数据"
});

registerToolMetadata({
  name: "sessions_spawn",
  category: "execute",
  riskLevel: "medium",
  description: "创建新会话"
});

registerToolMetadata({
  name: "session_status",
  category: "control",
  riskLevel: "low",
  description: "获取会话状态"
});

// 网络工具
registerToolMetadata({
  name: "web_search",
  category: "network",
  riskLevel: "low",
  description: "网络搜索",
  // Plan 模式允许网络搜索
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "web_fetch",
  category: "network",
  riskLevel: "low",
  description: "获取网页内容",
  // Plan 模式允许网络获取
  allowedInPlanMode: true
});

// 自动化定时工具
registerToolMetadata({
  name: "automation_timer_read",
  category: "read",
  riskLevel: "low",
  description: "读取定时任务配置",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "automation_timer_set",
  category: "write",
  riskLevel: "medium",
  description: "设置定时任务（创建/更新/删除/启停）",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "automation_timer_query",
  category: "read",
  riskLevel: "low",
  description: "查询定时任务运行记录",
  allowedInPlanMode: true
});

// TodoWrite 工具
registerToolMetadata({
  name: "TodoWrite",
  category: "control",
  riskLevel: "low",
  description: "管理任务列表",
  allowedInPlanMode: true
});

// LSP 工具
registerToolMetadata({
  name: "LSP",
  category: "read",
  riskLevel: "low",
  description: "LSP 代码智能"
});

// Task 工具（启动子 Agent）
registerToolMetadata({
  name: "Task",
  category: "execute",
  riskLevel: "medium",
  description: "启动子任务"
});

// Skill 工具
registerToolMetadata({
  name: "Skill",
  category: "control",
  riskLevel: "low",
  description: "执行技能"
});

// MCP 工具
registerToolMetadata({
  name: "MCPSearch",
  category: "control",
  riskLevel: "low",
  description: "搜索 MCP 工具"
});
