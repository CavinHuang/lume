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
  if (!availableTools.has("browser") || !availableTools.has("web_search")) {
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

export function buildOfficeToolsSection(availableTools: Set<string>): string | null {
  const hasOfficeTools = availableTools.has("xlsx_create")
    || availableTools.has("office_unpack")
    || availableTools.has("office_convert")
    || availableTools.has("info_extract");

  if (!hasOfficeTools) return null;

  const routes: string[] = [];
  if (availableTools.has("xlsx_create")) {
    routes.push("- xlsx 读取/分析/创建/修改 → xlsx_create");
  }
  if (availableTools.has("office_unpack") || availableTools.has("info_extract")) {
    routes.push("- docx 读取/分析 → office_unpack 或 info_extract");
  }
  if (availableTools.has("docx_create")) {
    routes.push("- 创建 docx → docx_create");
  }
  if (availableTools.has("pptx_create")) {
    routes.push("- 创建 pptx → pptx_create");
  }
  if (availableTools.has("pdf_create")) {
    routes.push("- 创建 PDF → pdf_create");
  }
  if (availableTools.has("office_convert")) {
    routes.push("- 格式转换（xlsx→pdf、docx→pdf 等）→ office_convert");
  }
  if (availableTools.has("info_extract")) {
    routes.push("- 提取文档关键信息（合同、简历、报告等）→ info_extract");
  }
  if (availableTools.has("office_validate")) {
    routes.push("- 校验文档结构 → office_validate");
  }

  return `## Office 文档处理策略（强制）

当用户上传或提及 Office 文档（xlsx、docx、pptx、pdf）时，必须优先使用内置的 Office 工具，不要通过 bash 执行 Python 代码来处理文档。

${routes.join("\n")}

仅在 Office 工具明确不可用（被工具策略禁用）或需要 openpyxl/docx 不支持的特殊库（如 pandas 复杂数据分析）时才回退 bash + Python。`;
}
