import { canonicalizeAgentToolName } from "@lume/shared";
import type { LumeToolRiskLevel } from "./tool-types";

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
  riskLevel: LumeToolRiskLevel;
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
  TOOL_METADATA_REGISTRY.set(canonicalizeAgentToolName(metadata.name), {
    ...metadata,
    allowedInPlanMode: metadata.allowedInPlanMode ?? isCategoryAllowedInPlanMode(metadata.category)
  });
}

/**
 * 获取工具元数据
 */
export function getToolMetadata(toolName: string): ToolMetadata | undefined {
  return TOOL_METADATA_REGISTRY.get(canonicalizeAgentToolName(toolName));
}

/**
 * 判断类别是否在 Plan 模式下允许
 */
function isCategoryAllowedInPlanMode(category: ToolCategory): boolean {
  return category === "read" || category === "control";
}

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

  const normalized = canonicalizeAgentToolName(toolName);

  // 根据名称推断类别和风险
  let category: ToolCategory = "read";
  let riskLevel: LumeToolRiskLevel = "low";

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
  description: "向用户提问",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "TaskReport",
  category: "control",
  riskLevel: "low",
  description: "写入当前任务执行结果",
  allowedInPlanMode: false
});

// 记忆工具
registerToolMetadata({
  name: "memory.search",
  category: "read",
  riskLevel: "low",
  description: "搜索记忆内容"
});

registerToolMetadata({
  name: "memory.read",
  category: "read",
  riskLevel: "low",
  description: "读取记忆内容"
});

registerToolMetadata({
  name: "memory.remember",
  category: "write",
  riskLevel: "medium",
  description: "保存结构化记忆"
});

registerToolMetadata({
  name: "memory.evidence.search",
  category: "read",
  riskLevel: "low",
  description: "搜索当前 Dream 任务的受限记忆证据"
});

registerToolMetadata({
  name: "memory.evidence.read",
  category: "read",
  riskLevel: "low",
  description: "读取当前 Dream 任务的单条受限记忆证据"
});

registerToolMetadata({
  name: "memory.forget",
  category: "write",
  riskLevel: "medium",
  description: "按用户明确意图归档记忆"
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

registerToolMetadata({
  name: "guanlan_search",
  category: "network",
  riskLevel: "low",
  description: "Guanlan 中文互联网搜索",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "guanlan_read",
  category: "network",
  riskLevel: "low",
  description: "Guanlan 中文网页阅读",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "guanlan_hotnews",
  category: "network",
  riskLevel: "low",
  description: "Guanlan 中文热榜",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "guanlan_research",
  category: "network",
  riskLevel: "low",
  description: "Guanlan 研究证据包",
  allowedInPlanMode: true
});

// 自动化定时工具
registerToolMetadata({
  name: "cron_read",
  category: "read",
  riskLevel: "low",
  description: "读取定时任务配置",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "automation_read",
  category: "read",
  riskLevel: "low",
  description: "读取自动化任务配置",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "cron_set",
  category: "write",
  riskLevel: "medium",
  description: "设置定时任务（创建/更新/删除/启停）",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "automation_set",
  category: "write",
  riskLevel: "high",
  description: "设置自动化任务（创建/更新/删除/启停/立即执行）",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "cron_query",
  category: "read",
  riskLevel: "low",
  description: "查询定时任务运行记录",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "automation_query",
  category: "read",
  riskLevel: "low",
  description: "查询自动化任务运行记录",
  allowedInPlanMode: true
});

// routine 家族：trigger 创建并立即执行自动化任务（对齐 automation_set 的 high），
// update/regenerate 写日程并重新调度——显式注册避免名称推断漏网
registerToolMetadata({
  name: "routine_read",
  category: "read",
  riskLevel: "low",
  description: "读取每日日程安排",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "routine_trigger",
  category: "execute",
  riskLevel: "high",
  description: "手动触发日程条目：创建自动化任务并立即执行 agent run",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "routine_update",
  category: "write",
  riskLevel: "medium",
  description: "修改今日日程条目",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "routine_regenerate",
  category: "write",
  riskLevel: "medium",
  description: "重新生成今日日程并重新调度",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "suggestion_analyze",
  category: "write",
  riskLevel: "medium",
  description: "运行 LLM 分析并写入建议库",
  allowedInPlanMode: false
});

// Reading 工具
registerToolMetadata({
  name: "lume_reading_snapshot",
  category: "read",
  riskLevel: "low",
  description: "读取 Lume Reading 书架和笔记快照",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "lume_add_book",
  category: "write",
  riskLevel: "medium",
  description: "向 Lume Reading 添加书籍",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "lume_write_reading_note",
  category: "write",
  riskLevel: "medium",
  description: "写入 Lume Reading 读书笔记",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "lume_hide_reading_note",
  category: "write",
  riskLevel: "medium",
  description: "隐藏 Lume Reading 读书笔记",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "lume_revise_reading_note",
  category: "write",
  riskLevel: "medium",
  description: "修订 Lume Reading 读书笔记",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "lume_reading_advance_progress",
  category: "write",
  riskLevel: "medium",
  description: "推进在读书籍阅读进度并可能标记 finished（写 reading store）",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "lume_reading_pick_next",
  category: "write",
  riskLevel: "medium",
  description: "从 queued 书中挑选下一本开始阅读（写 reading store）",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "lume_generate_share_card",
  category: "write",
  riskLevel: "medium",
  description: "生成 Lume Reading 分享卡片本地资产",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "office_validate",
  category: "read",
  riskLevel: "low",
  description: "只读校验 Office OOXML 文档结构",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "office_unpack",
  category: "write",
  riskLevel: "medium",
  description: "安全解包 Office OOXML 文档到本地目录",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "office_pack",
  category: "write",
  riskLevel: "medium",
  description: "将解包目录重新打包为 Office OOXML 文档",
  allowedInPlanMode: false
});

// office 其余工具：spawn 进程/写文档产物，显式注册避免被 inferToolMetadata 按名称关键词
// 误推断为 read/low（office_convert/office_clean 等不含任何关键词，曾整批免审批+Plan 放行）
registerToolMetadata({
  name: "office_convert",
  category: "execute",
  riskLevel: "medium",
  description: "调用 LibreOffice 无头转换 Office 文档格式（spawn soffice 并写产物）",
  allowedInPlanMode: false
});

for (const [name, description] of [
  ["office_clean", "产出剔除冗余元素的文档副本"],
  ["docx_create", "生成 docx 文档"],
  ["pptx_create", "生成 pptx 演示文稿"],
  ["xlsx_create", "生成 xlsx 表格"],
  ["pdf_create", "生成 pdf 文档"],
  ["docx_comment", "向 docx 插入批注"],
  ["pptx_add_slide", "向 pptx 追加幻灯片"],
  ["xlsx_recalc", "重算 xlsx 公式"],
  ["pdf_tools", "PDF 合并/拆分/旋转/水印/加密/提取图片"],
  ["office_extract_style", "提取文档设计样式并写 yaml 产物"],
  ["office_thumbnail", "渲染文档页缩略图"],
  ["office_accept_changes", "产出接受全部修订的文档副本"]
] as const) {
  registerToolMetadata({
    name,
    category: "write",
    riskLevel: "medium",
    description,
    allowedInPlanMode: false
  });
}

registerToolMetadata({
  name: "info_extract",
  category: "read",
  riskLevel: "low",
  description: "从文档提取结构化信息（纯分析，无产物落盘）",
  allowedInPlanMode: true
});

registerToolMetadata({
  name: "weread_generate_note",
  category: "write",
  riskLevel: "medium",
  description: "基于微信读书内容生成 Lume Reading 本地笔记",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "weread_export_all_notes",
  category: "write",
  riskLevel: "medium",
  description: "导出 Lume Reading 笔记本地文件",
  allowedInPlanMode: false
});

for (const name of [
  "weread_shelf",
  "weread_notebooks",
  "weread_reading_profile",
  "weread_bookmarks",
  "weread_best_bookmarks",
  "weread_reviews",
  "weread_public_reviews",
  "weread_readdata",
  "weread_search",
  "weread_book_info",
  "weread_chapters",
  "weread_book_context",
  "weread_recommend",
  "weread_similar"
]) {
  registerToolMetadata({
    name,
    category: "network",
    riskLevel: "low",
    description: "读取已授权微信读书数据",
    allowedInPlanMode: true
  });
}

// IM 工具
registerToolMetadata({
  name: "send_im_message",
  category: "execute",
  riskLevel: "medium",
  description: "向当前线程绑定的 IM 会话发送消息",
  allowedInPlanMode: false
});

registerToolMetadata({
  name: "send_im_media",
  category: "execute",
  riskLevel: "medium",
  description: "向当前线程绑定的 IM 会话发送图片或文件",
  allowedInPlanMode: false
});

// UI 个性化工具
registerToolMetadata({
  name: "personalize_ui",
  category: "write",
  riskLevel: "medium",
  description: "读取或更新 Lume 支持的界面状态",
  allowedInPlanMode: false
});

// Persistent Task tools (main-agent only; subagent assembly applies a deny set)
for (const name of ["TaskCreate", "TaskUpdate", "TaskStop"]) {
  registerToolMetadata({
    name,
    category: "control",
    riskLevel: "medium",
    description: "管理主 Agent 的持久化 Task",
    allowedInPlanMode: false,
  });
}

for (const name of ["TaskList", "TaskGet"]) {
  registerToolMetadata({
    name,
    category: "read",
    riskLevel: "low",
    description: "读取主 Agent 的持久化 Task",
    allowedInPlanMode: true,
  });
}

// TodoWrite 工具
registerToolMetadata({
  name: "TodoWrite",
  category: "control",
  riskLevel: "low",
  description: "管理任务列表",
  allowedInPlanMode: false
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

// 图像生成工具
registerToolMetadata({
  name: "image_gen",
  category: "execute",
  riskLevel: "medium",
  description: "调用配置的图像生成模型生成或编辑图片"
});

registerToolMetadata({
  name: "list_image_models",
  category: "read",
  riskLevel: "low",
  description: "列出已配置的图像生成模型及可用性"
});

registerToolMetadata({
  name: "dingtalk_cli",
  category: "execute",
  riskLevel: "high",
  description: "执行钉钉 IM CLI(dws)子命令:发消息、查日历、读文档、查通讯录等企业 IM 操作"
});

registerToolMetadata({
  name: "feishu_cli",
  category: "execute",
  riskLevel: "high",
  description: "执行飞书 IM CLI(lark-cli)子命令:发消息、查日历、读文档、查通讯录、多维表格等企业 IM 操作"
});

registerToolMetadata({
  name: "wecom_cli",
  category: "execute",
  riskLevel: "high",
  description: "执行企业微信 IM CLI(wecom-cli)子命令:发消息、查通讯录、管理应用等企业 IM 操作"
});
