# Lume 记忆与洞察中心设计

状态：已确认设计，等待实现计划

## 背景

当前 Lume 有两个与记忆有关的用户入口：侧栏的“主动中心”和“设置 → 记忆”。主动中心只展示记忆数量、待确认记忆和用户画像占位，并把用户跳转到设置；设置中的记忆页则同时承担原子记忆管理、Persona、Workspace Brief、待处理、资料导入、后台整理和运行配置。

这种结构造成了入口重复、职责不清和日常功能藏在设置里的问题。本设计将日常记忆能力收敛到一个入口，同时保留设置作为高级系统配置入口。

## 目标

- 侧栏提供唯一日常记忆入口，名称为“记忆与洞察”。
- 用户从一个中心完成记忆查看、确认、修正、导入、整理和后台任务跟踪。
- 默认打开“需要处理”，优先呈现需要用户决策的内容。
- 设置页只保留记忆系统的高级配置和诊断信息。
- 不复制自动化管理；自动化继续由独立“自动化”页面负责。
- 复用现有 Memory V2 RPC、Snapshot、MutationReceipt 和运行时事件契约。

## 非目标

- 本次不改变 Markdown 存储结构、记忆命令服务、召回算法或后台 Agent 运行时。
- 本次不重命名内部 `proactive` tab 类型和 `__proactive__` tab ID。
- 本次不把自动化 CRUD 搬入记忆中心。
- 本次不新增第二套记忆聚合数据库或新的外部依赖。

## 信息架构

用户可见入口：

```text
记忆与洞察
├─ 需要处理（默认）
├─ 记忆
├─ 洞察
└─ 活动
```

### 需要处理

这是默认页，不是统计仪表盘，而是可清空的处理队列。内容包括：

- 记忆冲突：查看候选与现有记忆的差异，采用、保留或编辑后采用。
- 低置信候选：确认、修正或忽略。
- 可能过期的记忆：确认、修正或归档。
- 待定洞察建议：接受、忽略或禁止此类建议。
- 失败或中断的记忆任务：查看原因、重试或忽略。运行中的任务只显示当前阶段和停止入口。

处理成功后条目从队列移除，并提供短时撤销。队列为空时展示最近几条记忆活动，不显示空洞的指标卡片。

### 记忆

承接当前记忆设置中的日常管理能力，内部视图为：

- 最近记住：按 Mutation Journal 的更新时间查看最近变化。
- 关于你：global identity/preference 条目和对应 Persona 入口。
- 当前工作区：workspace 条目和 Workspace Brief 入口。
- 全部记忆：跨 scope 的文本、status、source、facet、更新时间过滤。

条目详情继续支持 statement、Claim、证据、版本链、scope 移动、Pin、Activation、有效期、修正、归档、忘记、撤销和打开源文件。

“添加记忆”统一为一个入口，提供手动输入、粘贴资料、选择文件和选择文件夹。外部资料和手动整理启动后台 Job，完成状态在“活动”中查看。

### 洞察

只展示派生结果，不作为事实源：

- 用户画像及“纠正画像”入口。
- Workspace Brief 的摘要入口；完整项目记忆切换到“记忆 → 当前工作区”。
- Proma 工作模式建议。

Persona 和 Workspace Brief 只能通过底层记忆变更重建。洞察页面可追溯到相关条目，但不直接编辑派生 Markdown。

### 活动

统一展示 Mutation Journal 和 MemoryJobService 任务：

- 主 Agent、后台提取、整理、导入产生的变更回执。
- queued、running、completed、failed、cancelled、interrupted 状态。
- 阶段、进度、扫描/处理数量、变更摘要、失败原因、停止和重试。
- 聊天中的 `memory.changed`、`memory.job.progress`、`memory.job.completed` 通知可以深链到对应活动。

自动化页面仍是自动化任务的唯一管理入口；记忆与洞察中心不重复渲染活跃自动化列表，只展示由洞察产生的自动化建议。活动页保存完整任务历史，需要处理页只显示当前需要用户动作的失败、中断和运行中任务。

## 设置边界

设置导航保留“记忆设置”，但将现有记忆内容页缩减为 `MemoryAdvancedSettings`，只包括：

- 主 Agent 主动记忆、后台自动提取、AutoDream 开关。
- 语义召回、embedding/rerank 模型状态、召回提示模式。
- 记忆工具权限组。
- 迁移版本、备份位置、诊断和本地 ONNX 状态。

设置页不再渲染记忆条目、待处理列表、Persona、Workspace Brief、资料导入和整理任务详情，也不再为这些内容单独请求完整 `MemorySettingsSnapshot`。高级设置继续使用 `getMemoryRuntimeConfig`；迁移、embedding/rerank 和本地 ONNX 状态使用一个不包含 entries、pending、activity 的轻量 `MemoryDiagnosticsSnapshot` 投影。该投影复用现有状态服务，不引入第二套存储或聚合数据库。

## 组件与路由

保留内部 `proactive` tab 类型和 `__proactive__` tab ID，避免已保存标签页和导航状态迁移。仅修改用户可见标题和侧栏文案。

前端组件边界：

```text
MemoryInsightsHub
├─ MemoryAttentionView
├─ MemoryLibraryView
├─ MemoryInsightsView
├─ MemoryActivityView
└─ MemoryEntryDetail

MemoryAdvancedSettings
├─ MemoryAutomationSettings
├─ MemoryRetrievalSettings
├─ MemoryToolPermissionSettings
└─ MemoryMigrationDiagnostics
```

当前 `MemorySettings.tsx` 中的条目列表、详情、待处理、Persona、Workspace Brief、资料导入和任务面板拆入中心组件；纯配置和诊断逻辑留在设置组件。纯函数标签、过滤器和摘要工具移动到共享的 memory-center view model，避免中心和设置重复定义。

## 数据流与刷新

继续使用现有 `MemorySettingsSnapshot` 作为中心的读取契约。它已经包含 entries、pending、activity、jobs、Workspace Brief、迁移状态和召回状态。`MemoryAdvancedSettings` 不读取该完整契约，只读取运行配置和轻量 `MemoryDiagnosticsSnapshot`。

运行时事件统一驱动刷新：

```text
memory.changed
memory.job.progress
memory.job.completed
           ↓
    memoryCenterVersionAtom
           ↓
  当前工作区 Snapshot 刷新
```

中心只订阅当前 workspace 的事件。任务运行时保留低频兜底轮询，用于事件丢失、重启恢复和终态确认。切换工作区时清空选中条目、深链和正在编辑的草稿。

深链状态统一使用：

```ts
{
  section: "attention" | "memory" | "insights" | "activity"
  memoryId?: string
  mutationId?: string
  jobId?: string
}
```

聊天通知、建议卡片、设置诊断和后台任务通知都通过同一导航状态打开目标内容。

## 异常与恢复

- 首次加载失败只影响当前中心，并提供重试。
- 刷新失败保留上一份数据并提示数据可能不是最新。
- 记忆操作收到 MutationReceipt 后才从队列移除。
- revision 冲突保留编辑内容，要求重新加载后确认。
- 失败或中断任务进入“需要处理”，可重试或忽略。
- 迁移失败显示失败文件和备份位置，不重复弹出多个 Toast。
- Persona/Workspace Brief 不可用时只降级“洞察”，不阻塞原子记忆管理。
- 无工作区时中心显示创建或选择工作区的空状态。

## 验收与测试

### 组件测试

- 侧栏显示“记忆与洞察”，默认 section 为“需要处理”。
- 队列项目可完成、忽略、重试，完成后从队列移除并支持撤销。
- “记忆”四个视图保留原有过滤、详情、修正、归档和导入能力。
- “洞察”只显示 Persona、Workspace Brief 摘要和建议，不重复完整记忆列表。
- “活动”显示 Mutation Journal 和 MemoryJobService 的各状态。
- 设置页不渲染条目、待处理、Persona、Workspace Brief、导入和整理详情。
- 工作区切换不会残留旧条目详情。

### 事件与集成测试

- `memory.changed`、`memory.job.progress`、`memory.job.completed` 会刷新中心。
- 高级设置只依赖运行配置和 `MemoryDiagnosticsSnapshot`，不会加载或渲染原子记忆列表。
- 聊天通知可以深链到指定 section、memoryId、mutationId 或 jobId。
- 旧 `__proactive__` tab 可恢复并显示新用户界面。
- 事件丢失时兜底轮询可以恢复终态。
- 迁移失败能在“需要处理”展示具体文件与备份位置。

## 实施顺序

1. 提取共享 memory view model 和事件刷新状态。
2. 将 `MemorySettings` 的日常管理组件迁入 `MemoryInsightsHub`。
3. 将 `ProactiveHub` 的记忆重复区删除，保留建议与导航壳。
4. 将设置页收敛为 `MemoryAdvancedSettings`。
5. 更新侧栏、深链、聊天通知和现有测试。
6. 运行相关 web/shared/sidecar 类型检查与组件测试，再进行桌面端 smoke。

## 明确取舍

- 选择单一日常入口，接受中心组件拆分带来的短期文件移动成本。
- 保留设置中的高级配置，避免技术开关污染默认处理队列。
- 保留自动化独立页面，避免“记忆与洞察”变成泛化工作台。
- 保留内部 proactive 路由 ID，减少历史状态迁移风险。
- 复用现有 Snapshot 和 RPC，不为 UI 融合新增后端聚合层。
