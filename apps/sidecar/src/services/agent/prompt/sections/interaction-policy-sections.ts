type InteractionPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";

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

**当你遇到不确定的情况时：**
- 可以调用 AskUserQuestion 澄清需求或让用户在关键方案之间选择，然后再定稿计划
- 列出你考虑的选项和各自的利弊，让用户决策
- 不要用 AskUserQuestion 请求计划审批，例如“计划可以吗/是否继续”；计划审批必须通过 TaskContractWrite 创建的审批请求完成
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
1. 只能做只读探索和结构化规划；除 TaskContractWrite 写入计划文件外，不要修改文件、执行命令或调用写入类工具
2. 完成规划后，必须调用 TaskContractWrite，至少包含 goal、summary、steps、planMarkdown，并将 status 设为 needs_approval
3. planMarkdown 必须是可审阅的 Markdown 计划文档；TaskContractWrite 只会把它写入线程工作区计划文件并创建计划审批请求，不会创建可执行 task
4. 如果定稿前有关键不确定性，可以用 AskUserQuestion 澄清需求或让用户选择方案；不要用 AskUserQuestion 请求计划审批
5. TaskContractWrite 返回 planFilePath 和 planVerified 后，普通回复必须明确写出计划文件路径和验证状态，再说明等待用户审批
6. 对非平凡实现，先探索，再调用 planner 子代理基于探索结果设计实现方案；planner 只提供设计草案，不做审批、不修改文件、不调用 TaskContractWrite
7. 主线程负责审阅并调用 TaskContractWrite 提交待审批计划；不要把审批责任交给 planner
8. 用户批准后系统才会根据已审批计划创建 task 并执行；你在计划模式内不要提前执行
9. 不要把完整计划只写在普通回复里；普通回复只用于简短说明当前状态`;
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
