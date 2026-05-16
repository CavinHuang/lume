# Plan 模式审批流程改进

Status: Superseded by `docs/superpowers/specs/2026-05-10-codex-like-plan-mode-design.md`.

> 这份文档记录早期审批流程设计。当前实现以 `TaskContractWrite` 写入并验证 `plans/{contractId}.md` 为唯一计划出口；普通聊天反馈触发重规划，自然语言批准和按钮批准都进入同一条 TaskRun 执行路径。

## 背景与问题

当前 Plan 模式的审批流程存在以下问题：

1. 契约数据（`AgentTaskContract`）以 JSON 存储在 sidecar 中，用户只能通过侧面板的精简卡片审阅
2. 信息密度和可读性不足，难以评估完整的执行计划
3. 审批 UI 嵌在侧面板中，与计划内容分离，用户需要来回切换视线

## 设计目标

- 规划完成后产出可阅读的 Markdown 计划文件，供用户充分审查
- 审批操作集中在主区域（输入框上方），与计划预览形成流畅的审阅体验
- 执行进度仍由侧边栏 TaskProgressPanel 负责，职责分离清晰

## 完整流程

```
1. Agent 规划阶段（permissionMode: plan）
   └→ Agent 用 write 工具写 plan.md 到 sessions/{threadId}/plans/{YYYY-MM-DD}-{需求名称}.md
   └→ 同时用 TaskContractWrite 提交结构化契约

2. 规划完成（契约状态 → needs_approval）
   └→ 编辑器自动打开 plan.md 预览
   └→ 主区域输入框上方弹出审批横幅（批准 / 拒绝）

3. 用户审批
   ├→ 批准：生成 task list → 侧边栏 TaskProgressPanel 显示执行进度
   └→ 拒绝：弹出输入框填反馈 → Agent 根据反馈修改计划 → 重新提交审批

4. 执行完成
   └→ plan.md 标记为已完成（文件头 frontmatter 或文件名），保留作为历史记录
```

## 数据模型

### Plan 文件存储

- **路径**: `sessions/{threadId}/plans/{YYYY-MM-DD}-{需求名称}.md`
- **命名规则**: 日期 + 简短需求名称，如 `2026-05-06-add-user-auth.md`、`2026-05-06-plan-mode-review-improvement.md`
- **格式**: Markdown 文件，头部包含 YAML frontmatter 元数据

```yaml
---
contractId: "{contractId}"
threadId: "{threadId}"
status: draft | approved | completed | cancelled
createdAt: "2026-05-06T12:00:00Z"
approvedAt: "2026-05-06T12:05:00Z"
completedAt: "2026-05-06T13:00:00Z"
---

# 计划标题

## 目标
...

## 步骤
### 1. 步骤名称
...

## 风险与假设
...
```

### Plan 文件元数据（新增类型）

```typescript
interface PlanFileMeta {
  contractId: string
  threadId: string
  status: 'draft' | 'approved' | 'completed' | 'cancelled'
  filePath: string
  createdAt: string
  approvedAt?: string
  completedAt?: string
}
```

### IPC 通道（新增）

```typescript
PLAN_FILE_STATUS_CHANGED: 'agent:plan-file-status-changed'
```

在现有 `agent:get-pending-interactive` 返回值中，`taskApprovals` 字段附带 `planFilePath` 信息。

## 模块改动

### 1. Sidecar - TaskContractWrite 引导

**文件**: `apps/sidecar/src/services/agent-runtime/plan/task-contract-write-tool.ts`

- 在 tool description 中明确要求 Agent 在提交 `needs_approval` 状态契约时，先使用 `write` 工具将计划写入 `sessions/{threadId}/plans/{YYYY-MM-DD}-{需求名称}.md`
- 工具参数新增 `planFilePath?: string`，Agent 提交时附带文件路径
- 契约 store 中记录 `planFilePath`

### 2. Sidecar - Plan 文件状态管理

**新增文件**: `apps/sidecar/src/services/agent-runtime/plan/plan-file-service.ts`

职责：
- `markPlanApproved(filePath)` — 将 frontmatter 中 status 更新为 `approved`
- `markPlanCompleted(filePath)` — 将 status 更新为 `completed`
- `markPlanCancelled(filePath)` — 将 status 更新为 `cancelled`
- `readPlanMeta(filePath)` — 读取 frontmatter 元数据

### 3. Web - 自动打开 Plan 预览

**文件**: `apps/web/src/hooks/useGlobalAgentListeners.ts`

- 监听 `task_progress` 事件或 pendingInteractive 变化
- 当检测到 `taskApprovals` 包含 `planFilePath` 时，自动在编辑器中打开该文件
- 复用现有的文件打开能力

### 4. Web - PlanApprovalBanner 组件

**新增文件**: `apps/web/src/components/agent/PlanApprovalBanner.tsx`

位置：输入框上方（与 PermissionBanner 同层级）

状态：
- **待审批**: 显示「Agent 已完成规划，请审查计划」+ 批准/拒绝按钮
- **拒绝中**: 展开输入框，用户填写反馈 + 提交按钮
- **已批准**: 横幅消失，侧边栏 TaskProgressPanel 接管

交互：
- 批准按钮：调用 `agent:submit-task-approval`（approve: true）
- 拒绝按钮：展开内联输入框
- 提交反馈：调用 `agent:submit-task-approval`（approve: false, feedback: text），Agent 重新规划

### 5. Web - TaskProgressPanel 调整

**文件**: `apps/web/src/components/agent/TaskProgressPanel.tsx`

- 移除审批卡片 UI（已被 PlanApprovalBanner 替代）
- 保留执行进度展示：task list、进度条、continue/retry/skip 控制
- 在计划文件已存在时，顶部显示「查看计划文件」链接

### 6. Web - AgentInput 集成

**文件**: `apps/web/src/components/agent/AgentInput.tsx`

- 在 PermissionBanner 和 AskUserBanner 同级位置渲染 PlanApprovalBanner
- 仅在 planModePhase 为 `review` 且存在 pending taskApproval 时显示

## 约束与边界

- Plan 文件完全由 Agent 撰写，系统不自动生成，保证内容灵活性
- 审批横幅仅在 `review` 阶段显示，`executing` 阶段自动消失
- 拒绝后 Agent 重新规划时，会覆盖原 plan.md 文件（同一次规划周期内）
- 执行完成后 plan.md 保留不删除，作为历史可追溯
