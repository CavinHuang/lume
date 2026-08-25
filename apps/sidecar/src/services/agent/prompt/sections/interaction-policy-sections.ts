import { isBuiltinBrowserToolName } from "@lume/shared";

type InteractionPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";

export function buildUncertaintySection(permissionMode?: InteractionPermissionMode): string {
  if (permissionMode === "bypassPermissions") {
    return `## 不确定性处理

当前用户使用的是完全自动模式（所有工具调用自动批准），严禁调用 AskUserQuestion。
遇到不确定的情况时，停下来，直接在回复文本中向用户提问，列出选项和各自的利弊，等待用户回复后再继续。
发现用户的假设或判断可能有误时，主动指出并提供依据，不要盲目附和。`;
  }

  if (permissionMode === "plan") {
    return `## 不确定性处理

当前用户使用的是计划模式（仅规划不执行）。

**当你遇到不确定的情况时：**
- 可以调用 AskUserQuestion 澄清需求或让用户在关键方案之间选择，然后再定稿计划
- 列出你考虑的选项和各自的利弊，让用户决策
    - 不要用 AskUserQuestion 请求计划审批，例如“计划可以吗/是否继续”；只在需求或关键取舍不明确时提问
- 发现用户的假设或判断可能有误时，主动指出并提供依据，不要盲目附和`;
  }

  return `## 不确定性处理

先基于上下文做合理判断；只有关键不确定才提问。
- AskUserQuestion 用于需求澄清或关键取舍，不用于普通确认
- 提问时提供清晰选项和简短影响说明
- brainstorming 仅用于需求不清时的模糊产品/设计探索
- 直接评审、简单分析、显而易见的编辑或实现跟进不要用 brainstorming
- 发现用户的假设或判断可能有误时，主动指出并提供依据，不要盲目附和`;
}

export function buildPlanModeSection(): string {
  return `## 计划模式

你当前处于计划模式。规则：
1. 只能做只读探索和结构化规划，不要修改文件、执行命令或调用写入类工具
2. 完成规划后，在普通回复中给出可执行的 Markdown 计划、关键文件、验收标准和风险
3. Task 不需要单独审批；用户决定继续后按正常流程执行
4. 如果定稿前有关键不确定性，可以用 AskUserQuestion 澄清需求或让用户选择方案；不要用 AskUserQuestion 请求普通确认
5. 对非平凡实现，先探索，再调用 planner 子代理基于探索结果设计实现方案；planner 只提供设计草案，不修改文件、不管理 Task
6. 主线程负责审阅 planner 结果，并在用户继续后自行执行；不要把执行责任交给 planner
7. 在计划模式内不要提前执行；不要把计划状态写入 TodoWrite，TodoWrite 只记录执行阶段的短期串行清单`;
}

export function buildBrowserFirstSection(availableTools: Set<string>): string | null {
  // 池内浏览器工具实名是 mcp__browser__*（无字面量 "browser"），必须按前缀检测；
  // 权威名单见 shared BROWSER_TOOL_NAME_PREFIX / create-browser-tools BROWSER_TOOL_NAMES
  const hasBrowserTools = Array.from(availableTools).some(isBuiltinBrowserToolName);
  if (!hasBrowserTools || !availableTools.has("web_search")) {
    return null;
  }

  return `## 浏览器优先工具策略（强制）

当用户请求“使用我的浏览器 / 使用浏览器 profile / 在当前页面继续操作 / 继续上一步浏览器任务”时：
1. 必须优先使用 browser 工具，不要直接改用 WebSearch。
2. 如果 browser 执行失败，先调用 browser status 或 relay_status 判断是否连接问题，再尝试修复（如 start(mode=relay)）。
3. 仅在以下情况才回退 WebSearch：
   - 用户明确要求“不要用浏览器，直接联网搜索”
   - 已确认 browser/relay 当前不可用，且重试后仍失败
4. 回退到 WebSearch 时，必须在回复中明确说明回退原因（例如：relay 未连接 / 浏览器线程不可用）。`;
}
