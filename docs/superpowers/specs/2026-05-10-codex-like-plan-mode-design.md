# Codex-like Plan Mode 交互整理

Status: Draft for implementation planning

## 背景

Lume 当前已经有 Plan 模式、`TaskContractWrite`、线程内 `plan.md`、审批横幅和 TaskRun 执行链路。下一步目标不是新增一个更复杂的审批表单，而是把 Plan 模式做成更接近 Codex 的协作节奏：先只读探索和规划，用户自然审阅和反馈，明确批准后再执行。

公开文档中，Codex 的相关行为主要体现在 read-only / approval 模式和 App 任务侧栏体验上：Agent 可以先浏览上下文并产出 plan，用户可以检查计划、sources、artifacts 和 summary，再决定继续或调整。参考：

- https://developers.openai.com/codex/cli/features
- https://developers.openai.com/codex/app/features

## 目标

- Plan 模式成为一种自然的对话式协作流程，而不是单纯的工具审批弹窗。
- 计划必须是用户可直接阅读和修改意见可引用的 Markdown artifact。
- 规划阶段默认只读，不写代码、不执行会改变状态的命令。
- 用户可以用普通聊天消息修改计划，例如“重新梳理 1、2”“选 A”“风险写清楚一点”。
- 用户明确批准后，系统进入执行阶段，并由 TaskRun / TaskProgressPanel 展示进度。
- 拒绝或反馈后回到规划阶段，Agent 更新同一个线程计划并重新请求批准。

## 非目标

- 不重写整个权限系统。
- 不把 Plan 模式做成独立表单工作流。
- 不新增依赖。
- 不做完整 runtime resume 或 automation dashboard 改造。
- 不解决所有 legacy Claude 兼容读取问题；这是另一条安全/兼容清理线。

## Codex-like 交互模型

### 1. 发起

用户在 Plan 模式下发送需求。系统进入 `planning`。

Agent 可以：

- 读取项目文件和上下文。
- 搜索代码。
- 总结发现。
- 提出少量澄清问题。
- 生成或更新计划。

Agent 不应该：

- 修改业务代码。
- 运行会改变仓库或外部状态的命令。
- 未经批准直接进入执行。

### 2. 规划

Agent 生成一份可读计划，写入线程工作区内的 `plans/{contractId}.md`。

计划内容至少包含：

- 目标和边界。
- 当前理解和关键假设。
- 实施步骤。
- 涉及文件或模块。
- 验证方式。
- 风险和需要用户确认的点。

`TaskContractWrite` 负责提交结构化契约，并附带 `planFilePath` 和 `planVerified`。

### 3. 等待批准

系统进入 `awaiting_approval`。

UI 应该表达：

- Agent 已完成计划。
- 当前等待用户审阅。
- 计划文件可打开。
- 用户可以继续执行或继续反馈。

审批横幅保留轻量入口：

- `查看计划`
- `继续执行`

用户反馈不应主要依赖横幅里的小输入框；普通聊天输入应该是一等入口。

### 4. 修改计划

用户可以用自然语言反馈，例如：

- “重新梳理 1、2”
- “A”
- “先不要动 sdk”
- “风险部分写详细一点”

系统行为：

- 保持或回到 `planning`。
- 把用户反馈作为重新规划输入发送给 Agent。
- Agent 更新计划文件。
- Agent 再次提交待批准契约。

这一步不应该创建新的执行任务，也不应该让旧审批残留在 UI 里误导用户。

### 5. 批准并执行

用户明确批准，例如点击 `继续执行`，或发送“继续实现”“approve”“按这个做”。

系统行为：

- 关闭当前待审批计划。
- 进入 `executing`。
- 创建或继续 TaskRun。
- Agent 以非 plan 权限执行已经批准的计划。
- TaskProgressPanel 只展示执行进度，不承载重复审批语义。

### 6. 完成

执行完成后进入 `completed`。

系统应该保留：

- plan 文件。
- TaskRun 结果。
- 执行摘要。
- 未解决风险或后续建议。

## 状态机

```text
idle
  -> planning
  -> awaiting_approval
  -> executing
  -> completed

awaiting_approval --用户反馈--> planning
awaiting_approval --用户批准--> executing
executing --用户改范围/暂停--> planning
executing --完成--> completed
```

## Lume 当前映射

已有基础：

- `TaskContractWrite` 能提交结构化任务契约。
- 线程工作区内 `plan.md` 契约已确定。
- `TaskApprovalBanner` 已支持查看计划、批准、拒绝反馈。
- 拒绝反馈已经能回到 plan 权限继续发送给 Agent。
- 前端已能把 `planFilePath` 当 thread file tab 打开。

需要调整的重点：

- 把普通聊天输入作为修改计划的主入口。
- 审批横幅从“表单式拒绝”降级为轻量状态提示和快捷按钮。
- 明确 `awaiting_approval` 状态，不让 `review`、`planning`、`executing` 的语义混在一起。
- 让“继续实现”等自然语言批准路径和按钮批准走同一套执行入口。
- 清理或收束旧 fallback plan execution，避免绕过 TaskRun。

## UI 原则

- 计划内容在文件 tab 中审阅，不在横幅里重复渲染大段内容。
- 横幅只回答三个问题：现在等什么、计划在哪里、如何继续。
- 聊天输入在等待批准阶段仍然可用，并承担“反馈修改计划”的主职责。
- 批准动作必须明确，不因为用户普通追问而误启动执行。
- 执行开始后，审批横幅消失，侧边进度接管。

## 成功标准

- Plan 模式下 Agent 能先读上下文，再生成 verified plan file。
- 用户能打开计划文件审阅。
- 用户发送修改意见后，Agent 重新规划而不是执行。
- 用户发送“继续实现”或点击按钮后，进入同一条 TaskRun 执行路径。
- 执行阶段没有重复审批 UI。
- 相关测试覆盖计划反馈、自然语言批准、按钮批准和计划文件打开。

## 待确认问题

- 自然语言批准的识别应该是窄规则还是需要模型/Agent 判断。
- 等待批准阶段，是否允许工具审批和计划审批同时存在。
- 计划被多次修改时，是覆盖同一个文件还是按 revision 保留历史。
- 执行中用户要求改范围时，是自动回到 planning，还是先弹出确认。
