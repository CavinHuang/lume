type InteractionPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export function buildUncertaintySection(permissionMode?: InteractionPermissionMode): string {
  if (permissionMode === "bypassPermissions") {
    return `## 不确定性处理

当前用户使用的是完全自动模式（所有工具调用自动批准）。

**⚠️ 严禁调用 AskUserQuestion 工具！**
**当你遇到不确定的情况时：**
- **停下来，直接在回复文本中向用户提问**，等待用户回复后再继续
- 列出你考虑的选项和各自的利弊，让用户决策
- **绝对不要**调用 AskUserQuestion 工具，改为在普通文本回复中提问
- 发现用户的假设或判断可能有误时，主动指出并提供依据，不要盲目附和`;
  }

  if (permissionMode === "plan") {
    return `## 不确定性处理

当前用户使用的是计划模式（仅规划不执行）。

**⚠️ 严禁调用 AskUserQuestion 工具！**
**当你遇到不确定的情况时：**
- **停下来，直接在回复文本中向用户提问**，等待用户回复后再继续
- 列出你考虑的选项和各自的利弊，让用户决策
- **绝对不要**调用 AskUserQuestion 工具，改为在普通文本回复中提问
- 发现用户的假设或判断可能有误时，主动指出并提供依据，不要盲目附和`;
  }

  return `## 不确定性处理

先基于上下文做合理判断；只有关键不确定才提问。
- AskUserQuestion 用于需求澄清或关键取舍，不用于普通确认
- 提问时提供清晰选项和简短影响说明
- Use brainstorming only for ambiguous product/design exploration when requirements are unclear
- Skip brainstorming for direct critique, simple analysis, obvious edits, or implementation follow-through
- 发现用户的假设或判断可能有误时，主动指出并提供依据，不要盲目附和`;
}

export function buildPlanModeSection(): string {
  return `## 计划模式

你当前处于计划模式。规则：
1. 只能做只读探索和结构化规划，不要修改文件、执行命令或调用写入类工具
2. 完成计划后，必须调用 PlanWrite 写入结构化计划，至少包含 goal、summary、steps，并将 status 设为 needs_approval
3. PlanWrite 会把计划展示到右侧 Plan 面板，并创建计划批准请求；写入后在普通回复中简短说明计划已生成，等待用户批准
4. 不要把完整计划只写在普通回复里；普通回复只用于简短说明当前状态`;
}

export function buildBrowserFirstSection(availableTools: Set<string>): string | null {
  if (!availableTools.has("browser") || !availableTools.has("web_search")) {
    return null;
  }

  return `## Browser-First Tool Policy (Mandatory)

当用户请求“使用我的浏览器 / 使用浏览器 profile / 在当前页面继续操作 / 继续上一步浏览器任务”时：
1. 必须优先使用 browser 工具，不要直接改用 WebSearch。
2. 如果 browser 执行失败，先调用 browser status 或 relay_status 判断是否连接问题，再尝试修复（如 start(mode=relay)）。
3. 仅在以下情况才回退 WebSearch：
   - 用户明确要求“不要用浏览器，直接联网搜索”
   - 已确认 browser/relay 当前不可用，且重试后仍失败
4. 回退到 WebSearch 时，必须在回复中明确说明回退原因（例如：relay 未连接 / 浏览器线程不可用）。`;
}
