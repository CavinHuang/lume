/**
 * Agent 状态行：工具名 → 用户友好状态文字映射
 * key 统一小写，formatToolStatusLine 做大小写不敏感查找
 */

const TOOL_STATUS_MAP: Record<string, string> = {
  // 文件操作
  read: "正在读取文件",
  write: "正在写入文件",
  edit: "正在编辑文件",
  multiedit: "正在编辑文件",
  // 搜索与目录
  find: "正在查找文件",
  grep: "正在搜索内容",
  ls: "正在浏览目录",
  // 终端
  bash: "正在执行命令",
  // 控制工具
  askuserquestion: "正在向你提问",
  todowrite: "正在更新任务",
  // 子任务 / Agent
  task: "正在启动子任务",
  skill: "正在执行技能",
  // 记忆工具
  memory_search: "正在搜索记忆",
  memory_get: "正在读取记忆",
  memory_save: "正在保存记忆",
  // 网络
  web_search: "正在搜索网页",
  web_fetch: "正在获取网页",
  // 自动化定时
  cron_read: "正在读取定时任务",
  cron_set: "正在设置定时任务",
  cron_query: "正在查询定时记录",
  // LSP / MCP
  lsp: "正在分析代码",
  mcpsearch: "正在搜索 MCP 工具",
  // 子 Agent / 线程工具
  threads_spawn: "正在创建子 Agent",
  agents_list: "正在查询 Agent",
  threads_list: "正在查询线程",
  threads_history: "正在查询线程历史",
  threads_send: "正在与 Agent 通信",
  threads_delete: "正在清理线程",
  threads_delete_all: "正在清理线程",
  thread_status: "正在查询线程状态",
  subagents_list: "正在查询子 Agent",
  subagents_kill: "正在停止子 Agent",
  subagents_send: "正在与子 Agent 通信",
  subagents_steer: "正在调整子 Agent",
};

/**
 * 将工具名映射为用户友好的状态描述文字。
 * - 优先使用 intent（来自 Agent 事件的工具调用意图）
 * - 其次查表映射（大小写不敏感）
 * - 兜底显示 "正在执行 <toolName>"
 */
export function formatToolStatusLine(toolName: string, intent?: string): string {
  if (intent) return intent;
  return TOOL_STATUS_MAP[toolName.toLowerCase()] ?? `正在执行 ${toolName}`;
}
