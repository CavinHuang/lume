# 定时自动化系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有后端自动化服务基础上，新增前端管理 UI 和 Agent 工具改进，交付可用的定时自动化功能。

**Architecture:** 复用 sidecar 中已有的 `automation-manager.ts`（CRUD + JSON 存储）和 `automation-runner-service.ts`（cron 调度 + 线程执行），扩展通知和 toggle 能力。前端在设置页新增"自动化" tab，通过 `sidecarCall` 调用 IPC 通道。Agent 工具重命名并增加预设频率。

**Tech Stack:** TypeScript (Bun), React, Jotai, shadcn/ui, Tailwind CSS, Tauri IPC

---

## 文件变更概览

### 修改的文件

| 文件 | 变更内容 |
|------|----------|
| `packages/shared/src/types/automation.ts` | 新增 `TOGGLE_JOB`、`RUN_COMPLETED` IPC 通道常量 |
| `apps/sidecar/src/services/automation/automation-runner-service.ts` | 新增 `setNotificationWriter` + 执行完成后推送通知 |
| `apps/sidecar/src/rpc/schemas.ts` | 新增 `automationToggleInputSchema` |
| `apps/sidecar/src/rpc/automation-handlers.ts` | 新增 `TOGGLE_JOB` handler |
| `apps/sidecar/src/rpc/create-rpc-handlers.ts` | 将 `writeNotification` 传入 automation handlers |
| `apps/sidecar/src/index.ts` | 启动 runner 时设置 notification writer |
| `apps/sidecar/src/services/pi-agent/tools/cron/create-cron-tools.ts` | 工具重命名 + 新增预设频率支持 |
| `apps/sidecar/src/services/pi-agent/tools/create-lume-tools.ts` | 更新工具名常量 |
| `apps/web/src/components/settings/general-settings-state.ts` | 新增 `'automation'` tab 类型和导航项 |
| `apps/web/src/components/settings/SettingsView.tsx` | 新增 automation 图标和组件渲染 |

### 新增的文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/lib/desktop-api/automation.ts` | 前端 API 封装 |
| `apps/web/src/atoms/automation-atoms.ts` | Jotai 状态 atoms |
| `apps/web/src/components/automation/AutomationSettings.tsx` | 设置页自动化 tab 主组件 |
| `apps/web/src/components/automation/AutomationJobCard.tsx` | 任务卡片组件 |
| `apps/web/src/components/automation/AutomationJobDialog.tsx` | 新建/编辑对话框 |
| `apps/web/src/components/automation/AutomationRunList.tsx` | 执行历史列表 |
| `apps/web/src/hooks/useAutomationListeners.ts` | 事件监听 hook |

### 删除的文件

| 文件 | 说明 |
|------|------|
| `packages/sdk/src/tools/cron-tools.ts` | 被 automation-tools 替代（SDK 层 in-memory stub，实际不被 sidecar 使用） |

---

## Task 1: 共享类型 — 新增 IPC 通道

**Files:**
- Modify: `packages/shared/src/types/automation.ts:116-129`

- [ ] **Step 1: 在 `AUTOMATION_IPC_CHANNELS` 中新增 `TOGGLE_JOB` 和 `RUN_COMPLETED`**

在 `packages/shared/src/types/automation.ts` 的 `AUTOMATION_IPC_CHANNELS` 常量中追加两个通道：

```typescript
export const AUTOMATION_IPC_CHANNELS = {
  /** 获取任务列表 */
  LIST_JOBS: 'automation:list-jobs',
  /** 创建任务 */
  CREATE_JOB: 'automation:create-job',
  /** 更新任务 */
  UPDATE_JOB: 'automation:update-job',
  /** 删除任务 */
  DELETE_JOB: 'automation:delete-job',
  /** 启用/禁用任务 */
  TOGGLE_JOB: 'automation:toggle-job',
  /** 获取运行记录 */
  LIST_RUNS: 'automation:list-runs',
  /** 立即执行任务 */
  RUN_NOW: 'automation:run-now',
  /** 执行完成通知 */
  RUN_COMPLETED: 'automation:run-completed'
} as const
```

- [ ] **Step 2: 验证 shared 包编译**

Run: `cd packages/shared && bun run build`
Expected: 编译成功，无类型错误

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/automation.ts
git commit -m "feat(shared): add TOGGLE_JOB and RUN_COMPLETED IPC channels"
```

---

## Task 2: Runner 服务 — 执行完成通知

**Files:**
- Modify: `apps/sidecar/src/services/automation/automation-runner-service.ts`

- [ ] **Step 1: 新增 notification writer 注册**

在文件顶部 `lastCronMinuteKeyByJob` 声明之后（约 line 24），添加：

```typescript
type NotificationWriter = (method: string, params: unknown) => void;
let notificationWriter: NotificationWriter | null = null;

export function setAutomationNotificationWriter(writer: NotificationWriter): void {
  notificationWriter = writer;
}
```

- [ ] **Step 2: 在 `executeJob` 返回前推送通知**

在 `executeJob` 函数中，找到 `appendRun(run);` 这一行（约 line 227），在其后追加通知逻辑：

```typescript
    appendRun(run);
    if (notificationWriter) {
      notificationWriter("automation:run-completed", {
        run,
        jobName: job.name,
        jobEnabled: job.enabled
      });
    }
    return run;
```

- [ ] **Step 3: 验证 sidecar 编译**

Run: `cd apps/sidecar && bun run build`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/automation/automation-runner-service.ts
git commit -m "feat(sidecar): add notification callback for automation run completion"
```

---

## Task 3: RPC — 新增 toggle-job handler

**Files:**
- Modify: `apps/sidecar/src/rpc/schemas.ts:626-628`
- Modify: `apps/sidecar/src/rpc/automation-handlers.ts`

- [ ] **Step 1: 在 schemas.ts 中新增 toggle schema**

在 `automationRunNowInputSchema` 之后（约 line 628）追加：

```typescript
export const automationToggleInputSchema = z.object({
  id: idSchema
});
```

- [ ] **Step 2: 在 automation-handlers.ts 中新增 TOGGLE_JOB handler**

在 `automation-handlers.ts` 的 `createAutomationHandlers` 返回对象中，在 `RUN_NOW` 条目之后追加：

```typescript
    [AUTOMATION_IPC_CHANNELS.TOGGLE_JOB]: async (params) => {
      const input = validateInput(
        automationToggleInputSchema,
        params,
        AUTOMATION_IPC_CHANNELS.TOGGLE_JOB
      ) as { id: string };
      const jobs = listAutomationJobs();
      const target = jobs.find((j) => j.id === input.id);
      if (!target) {
        throw new Error(`自动化任务不存在: ${input.id}`);
      }
      const updated = updateAutomationJob({ id: target.id, enabled: !target.enabled });
      await refreshAutomationRunnerJobs();
      return updated;
    },
```

同时在文件顶部 import 中新增 `automationToggleInputSchema`：

```typescript
import {
  automationCreateInputSchema,
  automationDeleteInputSchema,
  automationListRunsInputSchema,
  automationRunNowInputSchema,
  automationToggleInputSchema,
  automationUpdateInputSchema
} from "./schemas";
```

- [ ] **Step 3: 验证编译**

Run: `cd apps/sidecar && bun run build`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/automation-handlers.ts
git commit -m "feat(sidecar): add automation toggle-job handler"
```

---

## Task 4: Sidecar 入口 — 连接通知

**Files:**
- Modify: `apps/sidecar/src/index.ts:107-111`

- [ ] **Step 1: 在启动 runner 后设置 notification writer**

将现有的 automation runner 启动代码（约 line 107-111）修改为：

```typescript
if (envAutostartEnabled("LUME_AUTOMATION_RUNNER_AUTOSTART", false)) {
  const { setAutomationNotificationWriter } = await import("./services/automation/automation-runner-service");
  setAutomationNotificationWriter(writeNotification);
  void startAutomationRunner().catch((error) => {
    console.error(`[自动化 Runner] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
  });
}
```

- [ ] **Step 2: 验证编译**

Run: `cd apps/sidecar && bun run build`
Expected: 编译成功

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/index.ts
git commit -m "feat(sidecar): wire automation notification writer on startup"
```

---

## Task 5: PI-Agent 工具 — 重命名 + 预设频率

**Files:**
- Modify: `apps/sidecar/src/services/pi-agent/tools/cron/create-cron-tools.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/create-lume-tools.ts`

- [ ] **Step 1: 在 create-cron-tools.ts 中重命名工具并添加预设频率**

将 `createSdkCronTools` 函数内的三个工具名从 `cron_read`/`cron_set`/`cron_query` 改为 `automation_read`/`automation_set`/`automation_query`。

同时更新 `automation_set` 中 `create` action 的逻辑，在 `parseSchedule` 之前增加预设频率转换：

在 `parseSchedule` 函数之后添加预设映射：

```typescript
const PRESET_CRON_MAP: Record<string, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekly: "0 9 * * 1",
  monthly: "0 9 1 * *"
};
```

在 `cron_set` 的 `create` action 中，在调用 `parseSchedule` 之前，检查 preset：

```typescript
        if (action === "create") {
          const name = asString(args.name);
          const prompt = asString(args.prompt);
          // 预设频率转换
          const preset = asString(args.preset);
          let scheduleRaw = args.schedule;
          if (preset && PRESET_CRON_MAP[preset]) {
            scheduleRaw = { type: "cron", cronExpr: PRESET_CRON_MAP[preset] };
          }
          const schedule = parseSchedule(scheduleRaw);
          if (!name) throw new Error("创建任务缺少 name");
          if (!prompt) throw new Error("创建任务缺少 prompt");
          const created = createAutomationJob({
            name,
            prompt,
            schedule,
            workspaceId,
            threadId,
            enabled: asBoolean(args.enabled)
          });
          return { ok: true, action, job: created };
        }
```

同时更新 `cron_set` 的 `inputSchema` 中 properties 添加 `preset` 字段：

```typescript
          preset: { type: "string", description: "预设频率: hourly | daily | weekly | monthly" },
```

将三个工具名更新：
- `cron_read` → `automation_read`
- `cron_set` → `automation_set`
- `cron_query` → `automation_query`

description 也更新为中文：
- `automation_read`: `"读取自动化任务配置"`
- `automation_set`: `"设置自动化任务（创建/更新/删除/启停/立即执行），支持预设频率（hourly/daily/weekly/monthly）"`
- `automation_query`: `"查询自动化任务运行记录"`

- [ ] **Step 2: 更新 create-lume-tools.ts 中的工具名常量**

将 `AUTOMATION_TOOL_NAMES` 更新：

```typescript
const AUTOMATION_TOOL_NAMES = [
  "automation_read",
  "automation_set",
  "automation_query"
];
```

- [ ] **Step 3: 验证编译**

Run: `cd apps/sidecar && bun run build`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/services/pi-agent/tools/cron/create-cron-tools.ts apps/sidecar/src/services/pi-agent/tools/create-lume-tools.ts
git commit -m "refactor(pi-agent): rename cron tools to automation tools, add preset frequency"
```

---

## Task 6: SDK 工具 — 替换 cron-tools

**Files:**
- Create: `packages/sdk/src/tools/automation-tools.ts`
- Modify: `packages/sdk/src/tools/index.ts`
- Delete: `packages/sdk/src/tools/cron-tools.ts`

注意：SDK 层的 cron-tools 是 in-memory stub，sidecar 实际使用 PI-Agent 工具。SDK 工具主要用于独立 SDK 模式。

- [ ] **Step 1: 创建 automation-tools.ts**

创建 `packages/sdk/src/tools/automation-tools.ts`：

```typescript
import type { ToolDefinition, ToolResult } from '../types.js'

const PRESET_CRON_MAP: Record<string, string> = {
  hourly: '0 * * * *',
  daily: '0 9 * * *',
  weekly: '0 9 * * 1',
  monthly: '0 9 1 * *',
}

export interface AutomationJob {
  id: string
  name: string
  prompt: string
  schedule: { type: string; cronExpr?: string; runAt?: number; intervalMs?: number }
  enabled: boolean
  workspaceId?: string
  createdAt: string
}

const jobStore = new Map<string, AutomationJob>()
let jobCounter = 0

export const AutomationCreateTool: ToolDefinition = {
  name: 'automation_create',
  description: 'Create an automation task. Supports cron expressions and preset frequencies (hourly/daily/weekly/monthly).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Task name' },
      prompt: { type: 'string', description: 'Prompt to execute' },
      schedule: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['cron', 'preset', 'once'] },
          expression: { type: 'string', description: 'Cron expression (type=cron)' },
          preset: { type: 'string', enum: ['hourly', 'daily', 'weekly', 'monthly'], description: 'Preset frequency (type=preset)' },
          runAt: { type: 'number', description: 'Timestamp for one-time execution (type=once)' },
        },
      },
    },
    required: ['name', 'prompt', 'schedule'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Create an automation task.' },
  async call(input: any): Promise<ToolResult> {
    const id = `auto_${++jobCounter}`
    let cronExpr = input.schedule?.expression
    if (input.schedule?.type === 'preset' && input.schedule.preset) {
      cronExpr = PRESET_CRON_MAP[input.schedule.preset]
    }
    const job: AutomationJob = {
      id,
      name: input.name,
      prompt: input.prompt,
      schedule: { type: input.schedule?.type === 'once' ? 'once' : 'cron', cronExpr, runAt: input.schedule?.runAt },
      enabled: true,
      createdAt: new Date().toISOString(),
    }
    jobStore.set(id, job)
    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Automation task created: ${id} "${job.name}"`,
    }
  },
}

export const AutomationListTool: ToolDefinition = {
  name: 'automation_list',
  description: 'List all automation tasks.',
  inputSchema: { type: 'object', properties: {} },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'List automation tasks.' },
  async call(): Promise<ToolResult> {
    const jobs = Array.from(jobStore.values())
    if (jobs.length === 0) {
      return { type: 'tool_result', tool_use_id: '', content: 'No automation tasks.' }
    }
    const lines = jobs.map(j =>
      `[${j.id}] ${j.enabled ? '✓' : '✗'} "${j.name}" schedule="${j.schedule.cronExpr ?? 'once'}" prompt="${j.prompt.slice(0, 50)}"`
    )
    return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
  },
}

export const AutomationDeleteTool: ToolDefinition = {
  name: 'automation_delete',
  description: 'Delete an automation task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID to delete' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Delete an automation task.' },
  async call(input: any): Promise<ToolResult> {
    if (!jobStore.has(input.id)) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }
    jobStore.delete(input.id)
    return { type: 'tool_result', tool_use_id: '', content: `Task deleted: ${input.id}` }
  },
}

export const AutomationUpdateTool: ToolDefinition = {
  name: 'automation_update',
  description: 'Update an automation task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' },
      name: { type: 'string', description: 'New name' },
      prompt: { type: 'string', description: 'New prompt' },
      enabled: { type: 'boolean', description: 'Enable/disable' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Update an automation task.' },
  async call(input: any): Promise<ToolResult> {
    const job = jobStore.get(input.id)
    if (!job) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }
    if (input.name !== undefined) job.name = input.name
    if (input.prompt !== undefined) job.prompt = input.prompt
    if (input.enabled !== undefined) job.enabled = input.enabled
    return { type: 'tool_result', tool_use_id: '', content: `Task updated: ${input.id} "${job.name}"` }
  },
}

export const AutomationRunNowTool: ToolDefinition = {
  name: 'automation_run_now',
  description: 'Immediately execute an automation task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID to execute' },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Execute an automation task now.' },
  async call(input: any): Promise<ToolResult> {
    const job = jobStore.get(input.id)
    if (!job) {
      return { type: 'tool_result', tool_use_id: '', content: `Task not found: ${input.id}`, is_error: true }
    }
    return { type: 'tool_result', tool_use_id: '', content: `Task triggered: ${input.id} "${job.name}" (async execution)` }
  },
}
```

- [ ] **Step 2: 更新 index.ts 导出**

在 `packages/sdk/src/tools/index.ts` 中，将 cron-tools 的导入替换为 automation-tools：

删除:
```typescript
import { CronCreateTool, CronDeleteTool, CronListTool, RemoteTriggerTool } from './cron-tools.js'
```

新增:
```typescript
import { AutomationCreateTool, AutomationListTool, AutomationDeleteTool, AutomationUpdateTool, AutomationRunNowTool } from './automation-tools.js'
```

在 `ALL_TOOLS` 数组中，将 cron 工具替换：

删除:
```typescript
  CronCreateTool,
  CronDeleteTool,
  CronListTool,
  RemoteTriggerTool,
```

新增:
```typescript
  AutomationCreateTool,
  AutomationListTool,
  AutomationDeleteTool,
  AutomationUpdateTool,
  AutomationRunNowTool,
```

- [ ] **Step 3: 删除 cron-tools.ts**

删除 `packages/sdk/src/tools/cron-tools.ts`。

- [ ] **Step 4: 验证 SDK 编译**

Run: `cd packages/sdk && bun run build`
Expected: 编译成功

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tools/automation-tools.ts packages/sdk/src/tools/index.ts
git rm packages/sdk/src/tools/cron-tools.ts
git commit -m "refactor(sdk): replace cron-tools with automation-tools, add preset frequency"
```

---

## Task 7: 前端 API 封装

**Files:**
- Create: `apps/web/src/lib/desktop-api/automation.ts`
- Modify: `apps/web/src/lib/desktop-api/index.ts`

- [ ] **Step 1: 创建 automation.ts**

创建 `apps/web/src/lib/desktop-api/automation.ts`：

```typescript
import { sidecarCall } from './system'
import type { AutomationJob, AutomationRun } from '@lume/shared'

export const listAutomationJobs = () =>
  sidecarCall<AutomationJob[]>('automation:list-jobs')

export const createAutomationJob = (input: {
  name: string
  prompt: string
  workspaceId?: string
  schedule: {
    type: string
    cronExpr?: string
    runAt?: number
    intervalMs?: number
  }
}) => sidecarCall<AutomationJob>('automation:create-job', input)

export const updateAutomationJob = (input: {
  id: string
  name?: string
  prompt?: string
  enabled?: boolean
  schedule?: {
    type: string
    cronExpr?: string
    runAt?: number
    intervalMs?: number
  }
}) => sidecarCall<AutomationJob>('automation:update-job', input)

export const deleteAutomationJob = (id: string) =>
  sidecarCall<{ ok: true }>('automation:delete-job', { id })

export const toggleAutomationJob = (id: string) =>
  sidecarCall<AutomationJob>('automation:toggle-job', { id })

export const runAutomationJobNow = (id: string) =>
  sidecarCall<AutomationRun>('automation:run-now', { id })

export const listAutomationRuns = (input?: { jobId?: string; limit?: number }) =>
  sidecarCall<AutomationRun[]>('automation:list-runs', input ?? {})
```

- [ ] **Step 2: 在 index.ts 中导出**

在 `apps/web/src/lib/desktop-api/index.ts` 中新增：

```typescript
export * from './automation'
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/desktop-api/automation.ts apps/web/src/lib/desktop-api/index.ts
git commit -m "feat(web): add automation desktop API wrappers"
```

---

## Task 8: 前端 Atoms

**Files:**
- Create: `apps/web/src/atoms/automation-atoms.ts`
- Modify: `apps/web/src/atoms/index.ts`

- [ ] **Step 1: 创建 automation-atoms.ts**

创建 `apps/web/src/atoms/automation-atoms.ts`：

```typescript
import { atom } from 'jotai'
import type { AutomationJob, AutomationRun } from '@lume/shared'

export const automationJobsAtom = atom<AutomationJob[]>([])
export const automationRunsAtom = atom<AutomationRun[]>([])
export const automationLoadingAtom = atom(false)
```

- [ ] **Step 2: 在 atoms/index.ts 中导出**

在 `apps/web/src/atoms/index.ts` 中新增：

```typescript
export * from './automation-atoms'
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/atoms/automation-atoms.ts apps/web/src/atoms/index.ts
git commit -m "feat(web): add automation Jotai atoms"
```

---

## Task 9: 前端 — AutomationJobCard 组件

**Files:**
- Create: `apps/web/src/components/automation/AutomationJobCard.tsx`

- [ ] **Step 1: 创建 AutomationJobCard.tsx**

创建 `apps/web/src/components/automation/AutomationJobCard.tsx`：

```tsx
import { Play, Pencil, Trash2, Clock, Loader2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { AutomationJob, AutomationRun } from '@lume/shared'

interface AutomationJobCardProps {
  job: AutomationJob
  runs: AutomationRun[]
  workspaces: { id: string; name: string; slug: string }[]
  onToggle: (id: string) => void
  onEdit: (job: AutomationJob) => void
  onDelete: (id: string) => void
  onRunNow: (id: string) => void
  loading: boolean
}

function describeSchedule(job: AutomationJob): string {
  const s = job.schedule
  if (s.type === 'cron') return `Cron: ${s.cronExpr}`
  if (s.type === 'once') return `一次性: ${new Date(s.runAt ?? 0).toLocaleString('zh-CN')}`
  if (s.type === 'interval') {
    const mins = Math.round((s.intervalMs ?? 0) / 60000)
    return `间隔: ${mins >= 60 ? `${Math.round(mins / 60)}小时` : `${mins}分钟`}`
  }
  return '未知调度'
}

function lastRunSummary(runs: AutomationRun[], jobId: string): string | null {
  const jobRuns = runs.filter(r => r.jobId === jobId)
  if (jobRuns.length === 0) return null
  const last = jobRuns[0]
  const time = new Date(last.startedAt).toLocaleString('zh-CN')
  const statusText = last.status === 'success' ? '成功' : last.status === 'failed' ? '失败' : '跳过'
  return `${time} · ${statusText}`
}

export function AutomationJobCard({ job, runs, workspaces, onToggle, onEdit, onDelete, onRunNow, loading }: AutomationJobCardProps) {
  const ws = workspaces.find(w => w.id === job.workspaceId)
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-foreground truncate">{job.name}</span>
            {!job.enabled && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">已禁用</Badge>
            )}
          </div>
          <p className="text-[12px] text-foreground/50">{describeSchedule(job)}</p>
        </div>
        <Switch
          checked={job.enabled}
          onCheckedChange={() => onToggle(job.id)}
          disabled={loading}
        />
      </div>

      <div className="flex items-center gap-3 text-[11px] text-foreground/40">
        <span className="flex items-center gap-1"><Clock size={11} /> {ws ? ws.name : '未绑定工作区'}</span>
        {lastRunSummary(runs, job.id) && (
          <span className="truncate">上次: {lastRunSummary(runs, job.id)}</span>
        )}
      </div>

      <p className="text-[12px] text-foreground/60 line-clamp-2">{job.prompt}</p>

      <div className="flex items-center gap-1.5 pt-1">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onRunNow(job.id)} disabled={loading || !job.enabled}>
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          执行
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onEdit(job)}>
          <Pencil size={12} />
          编辑
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-destructive hover:text-destructive" onClick={() => onDelete(job.id)}>
          <Trash2 size={12} />
          删除
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/automation/AutomationJobCard.tsx
git commit -m "feat(web): add AutomationJobCard component"
```

---

## Task 10: 前端 — AutomationJobDialog 组件

**Files:**
- Create: `apps/web/src/components/automation/AutomationJobDialog.tsx`

- [ ] **Step 1: 创建 AutomationJobDialog.tsx**

创建 `apps/web/src/components/automation/AutomationJobDialog.tsx`：

```tsx
import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AutomationJob } from '@lume/shared'

type ScheduleMode = 'preset' | 'cron' | 'once'

const PRESET_OPTIONS = [
  { value: 'hourly', label: '每小时', cron: '0 * * * *' },
  { value: 'daily', label: '每天 (09:00)', cron: '0 9 * * *' },
  { value: 'weekly', label: '每周一 (09:00)', cron: '0 9 * * 1' },
  { value: 'monthly', label: '每月1号 (09:00)', cron: '0 9 1 * *' },
]

interface AutomationJobDialogProps {
  open: boolean
  job?: AutomationJob | null
  workspaces: { id: string; name: string; slug: string }[]
  onSubmit: (data: {
    name: string
    prompt: string
    workspaceId: string
    schedule: { type: string; cronExpr?: string; runAt?: number }
  }) => void
  onCancel: () => void
}

export function AutomationJobDialog({ open, job, workspaces, onSubmit, onCancel }: AutomationJobDialogProps) {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('preset')
  const [preset, setPreset] = useState('daily')
  const [cronExpr, setCronExpr] = useState('0 9 * * *')
  const [runAtDate, setRunAtDate] = useState('')

  useEffect(() => {
    if (job) {
      setName(job.name)
      setPrompt(job.prompt)
      setWorkspaceId(job.workspaceId ?? '')
      if (job.schedule.type === 'once') {
        setScheduleMode('once')
        setRunAtDate(new Date(job.schedule.runAt ?? Date.now()).toISOString().slice(0, 16))
      } else if (job.schedule.type === 'cron') {
        const matching = PRESET_OPTIONS.find(p => p.cron === job.schedule.cronExpr)
        if (matching) {
          setScheduleMode('preset')
          setPreset(matching.value)
        } else {
          setScheduleMode('cron')
          setCronExpr(job.schedule.cronExpr ?? '')
        }
      }
    } else {
      setName('')
      setPrompt('')
      setWorkspaceId(workspaces[0]?.id ?? '')
      setScheduleMode('preset')
      setPreset('daily')
    }
  }, [job, open, workspaces])

  if (!open) return null

  const handleSubmit = () => {
    if (!name.trim() || !prompt.trim()) return
    let schedule: { type: string; cronExpr?: string; runAt?: number }
    if (scheduleMode === 'preset') {
      const opt = PRESET_OPTIONS.find(p => p.value === preset)
      schedule = { type: 'cron', cronExpr: opt?.cron ?? '0 9 * * *' }
    } else if (scheduleMode === 'cron') {
      schedule = { type: 'cron', cronExpr }
    } else {
      schedule = { type: 'once', runAt: new Date(runAtDate).getTime() }
    }
    onSubmit({ name: name.trim(), prompt: prompt.trim(), workspaceId, schedule })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="w-full max-w-lg rounded-2xl border border-border/50 bg-card shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border/50">
          <h3 className="text-[14px] font-medium">{job ? '编辑任务' : '新建任务'}</h3>
          <button onClick={onCancel} className="text-foreground/40 hover:text-foreground"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[12px]">任务名称</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日 PR 总结" className="text-[13px] h-8" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px]">工作区</Label>
            <select
              value={workspaceId}
              onChange={e => setWorkspaceId(e.target.value)}
              className="w-full h-8 rounded-md border border-input bg-background px-3 text-[13px]"
            >
              <option value="">不绑定工作区</option>
              {workspaces.map(ws => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px]">执行内容</Label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="Agent 执行的 prompt"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px]">调度方式</Label>
            <div className="flex gap-1.5">
              {(['preset', 'cron', 'once'] as ScheduleMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => setScheduleMode(mode)}
                  className={`px-3 py-1.5 rounded-lg text-[12px] transition-colors ${
                    scheduleMode === mode
                      ? 'bg-foreground/[0.08] text-foreground font-medium'
                      : 'text-foreground/50 hover:bg-foreground/[0.04]'
                  }`}
                >
                  {mode === 'preset' ? '预设频率' : mode === 'cron' ? 'Cron' : '一次性'}
                </button>
              ))}
            </div>
            {scheduleMode === 'preset' && (
              <select
                value={preset}
                onChange={e => setPreset(e.target.value)}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-[13px]"
              >
                {PRESET_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            )}
            {scheduleMode === 'cron' && (
              <Input value={cronExpr} onChange={e => setCronExpr(e.target.value)} placeholder="0 9 * * *" className="text-[13px] h-8 font-mono" />
            )}
            {scheduleMode === 'once' && (
              <Input type="datetime-local" value={runAtDate} onChange={e => setRunAtDate(e.target.value)} className="text-[13px] h-8" />
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border/50">
          <Button variant="ghost" size="sm" onClick={onCancel} className="text-[12px]">取消</Button>
          <Button size="sm" onClick={handleSubmit} disabled={!name.trim() || !prompt.trim()} className="text-[12px]">
            {job ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/automation/AutomationJobDialog.tsx
git commit -m "feat(web): add AutomationJobDialog component"
```

---

## Task 11: 前端 — AutomationRunList 组件

**Files:**
- Create: `apps/web/src/components/automation/AutomationRunList.tsx`

- [ ] **Step 1: 创建 AutomationRunList.tsx**

创建 `apps/web/src/components/automation/AutomationRunList.tsx`：

```tsx
import { CheckCircle2, XCircle, MinusCircle, ExternalLink } from 'lucide-react'
import type { AutomationRun } from '@lume/shared'

interface AutomationRunListProps {
  runs: AutomationRun[]
  onViewThread?: (threadId: string) => void
}

const statusConfig = {
  success: { icon: CheckCircle2, label: '成功', color: 'text-green-500' },
  failed: { icon: XCircle, label: '失败', color: 'text-red-500' },
  skipped: { icon: MinusCircle, label: '跳过', color: 'text-yellow-500' },
}

export function AutomationRunList({ runs, onViewThread }: AutomationRunListProps) {
  if (runs.length === 0) {
    return (
      <div className="py-8 text-center text-[12px] text-foreground/40">
        暂无执行记录
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {runs.map(run => {
        const cfg = statusConfig[run.status] ?? statusConfig.skipped
        const Icon = cfg.icon
        return (
          <div
            key={run.id}
            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-foreground/[0.02] text-[12px] group"
          >
            <Icon size={13} className={cfg.color} />
            <span className="text-foreground/70 truncate flex-1">{run.jobName}</span>
            <span className={`text-[11px] ${cfg.color}`}>{cfg.label}</span>
            <span className="text-foreground/40">
              {new Date(run.startedAt).toLocaleString('zh-CN')}
            </span>
            {run.threadId && onViewThread && (
              <button
                onClick={() => onViewThread(run.threadId!)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-foreground/40 hover:text-foreground"
              >
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/automation/AutomationRunList.tsx
git commit -m "feat(web): add AutomationRunList component"
```

---

## Task 12: 前端 — useAutomationListeners Hook

**Files:**
- Create: `apps/web/src/hooks/useAutomationListeners.ts`

- [ ] **Step 1: 创建 useAutomationListeners.ts**

先检查项目中事件监听的现有模式：

创建 `apps/web/src/hooks/useAutomationListeners.ts`：

```typescript
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { listen } from '@tauri-apps/api/event'
import { automationJobsAtom, automationRunsAtom } from '@/atoms/automation-atoms'
import { listAutomationJobs, listAutomationRuns } from '@/lib/desktop-api/automation'
import type { AutomationRun } from '@lume/shared'

export function useAutomationListeners() {
  const setJobs = useSetAtom(automationJobsAtom)
  const setRuns = useSetAtom(automationRunsAtom)

  useEffect(() => {
    let cancelled = false

    const loadData = async () => {
      try {
        const [jobs, runs] = await Promise.all([
          listAutomationJobs(),
          listAutomationRuns({ limit: 50 }),
        ])
        if (!cancelled) {
          setJobs(jobs)
          setRuns(runs)
        }
      } catch (error) {
        console.error('[自动化] 加载数据失败:', error)
      }
    }

    loadData()

    const unlisten = listen<{ method: string; params: { run: AutomationRun } }>('sidecar:event', (event) => {
      if (event.payload.method === 'automation:run-completed') {
        void loadData()
      }
    })

    return () => {
      cancelled = true
      unlisten.then(fn => fn())
    }
  }, [setJobs, setRuns])
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/hooks/useAutomationListeners.ts
git commit -m "feat(web): add useAutomationListeners hook"
```

---

## Task 13: 前端 — AutomationSettings 主组件

**Files:**
- Create: `apps/web/src/components/automation/AutomationSettings.tsx`

- [ ] **Step 1: 创建 AutomationSettings.tsx**

创建 `apps/web/src/components/automation/AutomationSettings.tsx`：

```tsx
import { useState, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { agentWorkspacesAtom } from '@/atoms'
import { automationJobsAtom, automationRunsAtom, automationLoadingAtom } from '@/atoms/automation-atoms'
import { useAutomationListeners } from '@/hooks/useAutomationListeners'
import {
  createAutomationJob,
  updateAutomationJob,
  deleteAutomationJob,
  toggleAutomationJob,
  runAutomationJobNow,
} from '@/lib/desktop-api/automation'
import { AutomationJobCard } from './AutomationJobCard'
import { AutomationJobDialog } from './AutomationJobDialog'
import { AutomationRunList } from './AutomationRunList'
import type { AutomationJob } from '@lume/shared'

export function AutomationSettings() {
  useAutomationListeners()

  const workspaces = useAtomValue(agentWorkspacesAtom)
  const jobs = useAtomValue(automationJobsAtom)
  const runs = useAtomValue(automationRunsAtom)
  const [loading, setLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<AutomationJob | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const wsList = workspaces.map(w => ({ id: w.id, name: w.name, slug: w.slug }))

  const handleToggle = useCallback(async (id: string) => {
    setLoading(true)
    try {
      await toggleAutomationJob(id)
    } catch (error) {
      console.error('[自动化] 切换失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleCreate = useCallback(async (data: {
    name: string
    prompt: string
    workspaceId: string
    schedule: { type: string; cronExpr?: string; runAt?: number }
  }) => {
    setLoading(true)
    try {
      await createAutomationJob(data)
      setDialogOpen(false)
    } catch (error) {
      console.error('[自动化] 创建失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleEdit = useCallback(async (data: {
    name: string
    prompt: string
    workspaceId: string
    schedule: { type: string; cronExpr?: string; runAt?: number }
  }) => {
    if (!editingJob) return
    setLoading(true)
    try {
      await updateAutomationJob({
        id: editingJob.id,
        name: data.name,
        prompt: data.prompt,
        workspaceId: data.workspaceId || undefined,
        schedule: data.schedule,
      })
      setDialogOpen(false)
      setEditingJob(null)
    } catch (error) {
      console.error('[自动化] 更新失败:', error)
    } finally {
      setLoading(false)
    }
  }, [editingJob])

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id)
    try {
      await deleteAutomationJob(id)
    } catch (error) {
      console.error('[自动化] 删除失败:', error)
    } finally {
      setDeletingId(null)
    }
  }, [])

  const handleRunNow = useCallback(async (id: string) => {
    try {
      await runAutomationJobNow(id)
    } catch (error) {
      console.error('[自动化] 执行失败:', error)
    }
  }, [])

  const openCreate = () => {
    setEditingJob(null)
    setDialogOpen(true)
  }

  const openEdit = (job: AutomationJob) => {
    setEditingJob(job)
    setDialogOpen(true)
  }

  const handleDialogSubmit = editingJob ? handleEdit : handleCreate

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-medium">自动化</h2>
          <p className="text-[12px] text-foreground/50 mt-0.5">管理定时任务和工作流自动化</p>
        </div>
        <Button size="sm" onClick={openCreate} className="text-[12px] h-8">
          <Plus size={14} />
          新建任务
        </Button>
      </div>

      {jobs.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-[13px] text-foreground/40">暂无自动化任务</p>
          <p className="text-[12px] text-foreground/30 mt-1">点击"新建任务"或在对话中让 Agent 帮你创建</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => (
            <AutomationJobCard
              key={job.id}
              job={job}
              runs={runs}
              workspaces={wsList}
              onToggle={handleToggle}
              onEdit={openEdit}
              onDelete={handleDelete}
              onRunNow={handleRunNow}
              loading={loading || deletingId === job.id}
            />
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-[13px] font-medium text-foreground/70">执行历史</h3>
        <AutomationRunList runs={runs} />
      </div>

      <AutomationJobDialog
        open={dialogOpen}
        job={editingJob}
        workspaces={wsList}
        onSubmit={handleDialogSubmit}
        onCancel={() => { setDialogOpen(false); setEditingJob(null) }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/automation/AutomationSettings.tsx
git commit -m "feat(web): add AutomationSettings main component"
```

---

## Task 14: 设置页集成

**Files:**
- Modify: `apps/web/src/components/settings/general-settings-state.ts:8,31-38`
- Modify: `apps/web/src/components/settings/SettingsView.tsx`

- [ ] **Step 1: 在 general-settings-state.ts 中增加 automation tab**

将 `SettingsTab` 类型更新：

```typescript
export type SettingsTab = 'general' | 'channels' | 'agent' | 'mcp' | 'skills' | 'automation' | 'about'
```

在 `SETTINGS_NAV_ITEMS` 数组中，`skills` 和 `about` 之间插入：

```typescript
  { id: 'automation', label: '自动化' },
```

- [ ] **Step 2: 在 SettingsView.tsx 中增加 automation 渲染**

新增 import：

```typescript
import { Timer } from 'lucide-react'
import { AutomationSettings } from '../automation/AutomationSettings'
```

在 `NAV_ICON_MAP` 中增加：

```typescript
  automation: <Timer size={15} />,
```

在右侧内容区的条件渲染中，在 `skills` 和 `about` 之间增加：

```typescript
          {tab === 'automation' && <AutomationSettings />}
```

- [ ] **Step 3: 验证前端编译**

Run: `cd apps/web && bun run build`
Expected: 编译成功

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/general-settings-state.ts apps/web/src/components/settings/SettingsView.tsx
git commit -m "feat(web): integrate automation tab into settings page"
```

---

## Task 15: 验证与清理

- [ ] **Step 1: 全量构建验证**

Run: `cd packages/shared && bun run build && cd ../../packages/sdk && bun run build && cd ../../apps/sidecar && bun run build && cd ../../apps/web && bun run build`
Expected: 全部编译成功

- [ ] **Step 2: 运行 sidecar 现有自动化测试**

Run: `cd apps/sidecar && bun test --test-name-pattern automation`
Expected: 所有现有测试通过

- [ ] **Step 3: 手动启动应用验证**

启动 Tauri 桌面应用，打开设置页，确认：
- 左侧导航显示"自动化"项
- 点击后显示空状态提示
- "新建任务"按钮打开对话框
- 对话框可填写并提交
- 任务列表显示卡片
- 启用/禁用 toggle 可用
- 执行历史区域可见

- [ ] **Step 4: Final Commit**

```bash
git add -A
git commit -m "feat(automation): complete automation UI and tooling integration"
```
