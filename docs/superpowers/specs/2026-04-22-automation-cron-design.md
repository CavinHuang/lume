# 定时自动化系统 — 设计文档

> 日期：2026-04-22
> 状态：已确认
> 分支：feat/new-ui
> 替代：2026-04-21-automation-redesign-design.md

## 1. 背景与目标

Lume 现有自动化系统（cron 调度 + JSON 存储 + JSONL 执行记录）已在 sidecar 中实现并通过测试，但缺少前端 UI 和部分关键能力。本设计以"最小可用"为原则，复用现有后端并扩展，不做过度设计。

核心目标：
- 用户可创建定时任务，到时间由 Agent 在新线程中执行
- 支持管理面板 UI 和 Agent 对话工具两种创建方式
- 执行完成后发送桌面通知，线程保留供用户回溯

## 2. 需求

| 项目 | 描述 |
|------|------|
| 调度方式 | Cron 表达式、预设频率（每天/每周/每小时/每月）、一次性定时 |
| 任务内容 | 简单 Prompt，发送给 Agent 执行 |
| 创建方式 | 设置页管理面板 + Agent 对话中通过工具创建 |
| 执行模型 | 创建新线程 → Agent 执行 → 桌面通知结果 → 线程保留可回溯 |
| 作用范围 | 全局展示，每个任务绑定特定工作区 |
| 管理入口 | 设置页新增"自动化" tab |

不做：事件触发、AI 自动发现、多步骤工作流、跨工作区调度。

## 3. 后端设计

### 3.1 复用策略

保留现有 sidecar 服务，在其上扩展：

- `automation-manager.ts` — 保留任务 CRUD + JSON 文件存储
- `automation-runner-service.ts` — 保留 cron 调度引擎，扩展执行逻辑
- `automation-handlers.ts` — 保留 IPC 注册，扩展通道

### 3.2 数据模型

```typescript
interface AutomationJob {
  id: string;
  name: string;                    // 任务名称（新增）
  workspaceId: string;             // 绑定工作区（新增）
  prompt: string;                  // Agent 执行的 prompt（新增）
  schedule: AutomationSchedule;    // cron | once | interval（现有）
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface AutomationRun {
  id: string;
  automationId: string;
  threadId: string;                // 执行线程 ID（新增）
  status: 'running' | 'success' | 'failed';
  triggeredBy: 'cron' | 'manual';
  startedAt: number;
  completedAt: number | null;
  result: string | null;
  error: string | null;
}
```

### 3.3 执行模型变更

现有：`executeJob()` 直接调用 `sendAgentMessage()`。
改为：

1. 在目标工作区创建新 Agent 线程
2. 向线程发送 prompt
3. 记录 `threadId` 到 `AutomationRun`
4. 线程执行完成后（通过 Agent 运行时回调），推送桌面通知

### 3.4 桌面通知

sidecar 通过 `writeNotification('automation:run-completed', payload)` 发送事件，Tauri 转发到前端。前端调用系统原生通知 API（Tauri 的 notification 插件或 Web Notification API）。

### 3.5 预设频率

在 Agent 工具层转换，不修改底层调度器：

| preset | cron 表达式 | 说明 |
|--------|------------|------|
| hourly | `0 * * * *` | 每小时整点 |
| daily | `0 9 * * *` | 每天早上 9 点 |
| weekly | `0 9 * * 1` | 每周一早上 9 点 |
| monthly | `0 9 1 * *` | 每月 1 号早上 9 点 |

### 3.6 IPC 通道

**请求通道（前端 → 后端）：**

| 通道 | 说明 |
|------|------|
| `automation:list-jobs` | 列出所有自动化任务 |
| `automation:create-job` | 创建任务 |
| `automation:update-job` | 更新任务 |
| `automation:delete-job` | 删除任务 |
| `automation:toggle-job` | 启用/禁用任务（新增） |
| `automation:list-runs` | 查看执行记录 |
| `automation:run-now` | 立即执行 |

**通知通道（后端 → 前端）：**

| 通道 | 说明 |
|------|------|
| `automation:run-completed` | 执行完成通知 |

### 3.7 存储

保留 JSON 文件存储：
- 任务定义：`~/.config/lume/automation/jobs.json`
- 执行记录：`~/.config/lume/automation/runs/all.jsonl`

## 4. Agent 工具

用户在对话中告诉 Agent 即可创建自动化任务。

### 4.1 工具列表

| 工具名 | 说明 |
|--------|------|
| `automation_create` | 创建自动化任务 |
| `automation_list` | 列出当前工作区的任务 |
| `automation_update` | 更新任务 |
| `automation_delete` | 删除任务 |
| `automation_run_now` | 立即执行一次 |

### 4.2 `automation_create` 参数

```typescript
{
  name: string;           // 任务名称
  prompt: string;         // 执行内容
  schedule: {
    type: 'cron' | 'preset' | 'once',
    expression?: string,  // cron 模式：标准 5 字段表达式
    preset?: 'hourly' | 'daily' | 'weekly' | 'monthly',
    runAt?: number,       // once 模式：时间戳
  }
}
```

任务自动绑定到当前对话所在工作区。

### 4.3 替换关系

- `packages/sdk/src/tools/cron-tools.ts` → `packages/sdk/src/tools/automation-tools.ts`
- `apps/sidecar/src/services/pi-agent/tools/cron/` → 重写为新的自动化工具

## 5. 前端设计

### 5.1 入口

设置页新增"自动化" tab（`SettingsTab` 类型增加 `'automation'`），排在"技能"和"关于"之间。

### 5.2 页面布局

左侧保持现有设置导航不变，右侧内容区展示自动化管理面板：

**上半部分 — 任务列表：**
- "新建任务"按钮，点击弹出创建对话框
- 卡片式任务列表，每个卡片包含：
  - 任务名称
  - 调度方式描述（如"每天 09:00"）
  - 绑定工作区名称
  - 上次执行时间和状态
  - 操作：启用/禁用 toggle、编辑、删除、立即执行

**下半部分 — 执行历史：**
- 表格/列表形式，显示：任务名、状态（成功/失败/运行中）、触发时间
- 点击条目跳转到对应的 Agent 线程查看执行详情

### 5.3 新建/编辑对话框

字段：
- 任务名称（文本输入）
- 工作区（下拉选择）
- Prompt（多行文本输入）
- 调度方式：
  - 预设频率（下拉：每小时/每天/每周/每月）
  - Cron 表达式（文本输入，仅当选择"自定义"时显示）
  - 一次性（日期时间选择器，仅当选择"一次性"时显示）

### 5.4 状态管理

```typescript
// atoms/automation-atoms.ts
automationJobsAtom: AutomationJob[]
automationRunsAtom: AutomationRun[]
automationLoadingAtom: boolean
```

通过 `useAutomationListeners` hook 监听 `automation:run-completed` 事件，实时更新 atoms。

### 5.5 文件结构

```
apps/web/src/
├── atoms/
│   └── automation-atoms.ts
├── components/automation/
│   ├── AutomationSettings.tsx       // 设置页 tab 内容
│   ├── AutomationJobCard.tsx        // 任务卡片
│   ├── AutomationJobDialog.tsx      // 新建/编辑对话框
│   └── AutomationRunList.tsx        // 执行历史列表
└── hooks/
    └── useAutomationListeners.ts
```

### 5.6 设置页集成

修改点：
1. `SettingsTab` 类型增加 `'automation'`
2. `SETTINGS_NAV_ITEMS` 数组增加自动化导航项
3. `SettingsView.tsx` 增加图标映射和条件渲染

## 6. 模块结构与文件变更

### 6.1 修改的文件

| 文件 | 变更 |
|------|------|
| `packages/shared/src/types/automation.ts` | 扩展类型定义 |
| `apps/sidecar/src/services/automation/automation-manager.ts` | 增加 workspaceId、name、prompt 字段支持 |
| `apps/sidecar/src/services/automation/automation-runner-service.ts` | 改为线程执行模型，增加桌面通知 |
| `apps/sidecar/src/rpc/automation-handlers.ts` | 增加 toggle-job、run-completed 通道 |
| `apps/sidecar/src/index.ts` | 确保自动化服务随 sidecar 启动 |

### 6.2 新增的文件

| 文件 | 说明 |
|------|------|
| `packages/sdk/src/tools/automation-tools.ts` | Agent SDK 自动化工具（替代 cron-tools） |
| `apps/sidecar/src/services/pi-agent/tools/automation/` | PI-Agent 自动化工具（替代 cron/） |
| `apps/web/src/atoms/automation-atoms.ts` | 前端状态 |
| `apps/web/src/components/automation/AutomationSettings.tsx` | 设置页自动化 tab |
| `apps/web/src/components/automation/AutomationJobCard.tsx` | 任务卡片组件 |
| `apps/web/src/components/automation/AutomationJobDialog.tsx` | 新建/编辑对话框 |
| `apps/web/src/components/automation/AutomationRunList.tsx` | 执行历史列表 |
| `apps/web/src/hooks/useAutomationListeners.ts` | 事件监听 hook |

### 6.3 删除的文件

| 文件 | 说明 |
|------|------|
| `packages/sdk/src/tools/cron-tools.ts` | 被 automation-tools.ts 替代 |
| `apps/sidecar/src/services/pi-agent/tools/cron/` | 被新工具替代 |

## 7. 不做的事

- 事件触发（仅 cron 定时）
- AI 自动发现自动化机会
- 多步骤工作流
- 跨工作区调度
- SQLite 存储（保留 JSON）
- 实时事件流
