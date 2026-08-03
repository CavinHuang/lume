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
    - 不要用 AskUserQuestion 请求计划审批，例如“计划可以吗/是否继续”；只在需求或关键取舍不明确时提问
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
2. 完成规划后，在普通回复中给出可执行的 Markdown 计划、关键文件、验收标准和风险
3. Task 不需要单独审批，也不要调用旧的 TaskContractWrite 或创建旧 TaskRun；用户决定继续后按正常流程执行
4. 如果定稿前有关键不确定性，可以用 AskUserQuestion 澄清需求或让用户选择方案；不要用 AskUserQuestion 请求普通确认
5. 对非平凡实现，先探索，再调用 planner 子代理基于探索结果设计实现方案；planner 只提供设计草案，不修改文件、不管理 Task
6. 主线程负责审阅 planner 结果，并在用户继续后自行执行；不要把执行责任交给 planner
7. 在计划模式内不要提前执行；不要把计划状态写入 TodoWrite，TodoWrite 只记录执行阶段的短期串行清单`;
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

export function buildOfficeToolsSection(availableTools: Set<string>): string | null {
  const hasOfficeTools = availableTools.has("xlsx_create")
    || availableTools.has("office_unpack")
    || availableTools.has("office_convert")
    || availableTools.has("info_extract");

  if (!hasOfficeTools) return null;

  return `## Office 文档处理策略（强制）

当用户上传或提及 Office 文档（xlsx、docx、pptx、pdf）时，必须优先使用内置的 Office 工具，不要通过 bash 执行 Python 代码来处理文档。

**工具选择指南：**

- **读取/分析 xlsx 数据** → 使用 xlsx_create 工具，code 参数传入 openpyxl Python 代码，无需 output_path，用 print() 输出结果
- **修改 xlsx 文件** → 使用 xlsx_create 工具，提供 output_path 保存修改后的文件
- **创建新 xlsx 文件** → 使用 xlsx_create 工具，提供 output_path 指定输出路径
- **读取/分析 docx 内容** → 使用 office_unpack 解包后读取 XML，或用 info_extract 提取结构化信息
- **创建 docx 文档** → 使用 docx_create 工具
- **创建 pptx 演示文稿** → 使用 pptx_create 工具
- **创建 PDF 文档** → 使用 pdf_create 工具
- **格式转换**（xlsx→pdf、docx→pdf 等）→ 使用 office_convert 工具
- **提取文档关键信息**（合同、简历、报告等）→ 使用 info_extract 工具
- **校验文档结构** → 使用 office_validate 工具
- **底层 XML 操作**（高级）→ office_unpack → 编辑 XML → office_pack

**xlsx_create 读取数据示例（无需 output_path）：**
\`\`\`python
import openpyxl
wb = openpyxl.load_workbook("已有文件.xlsx")
ws = wb.active
for row in ws.iter_rows(values_only=True):
    print(row)  # print() 输出会作为工具返回结果
\`\`\`

**xlsx_create 创建/修改文件示例（需要 output_path）：**
\`\`\`python
import openpyxl
wb = openpyxl.load_workbook("已有文件.xlsx")
ws = wb.active
ws["A1"] = "新值"
wb.save(output_path)  # output_path 由工具自动注入
\`\`\`

仅在以下情况才回退到 bash + Python：
- Office 工具明确不可用（被工具策略禁用）
- 需要使用 openpyxl/docx 不支持的特殊库（如 pandas 复杂数据分析）`;
}
