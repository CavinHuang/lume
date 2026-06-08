# 日程系统（Daily Routine）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Lume 构建一套 AI 动态生成的日程系统，每天自动安排读书笔记、记忆整理、周期总结等活动，替代现有固定间隔的读书节奏 runner。

**Architecture:** 复用现有 Automation 调度引擎作为执行层。新增 `routine` 服务作为编排层，负责每天早上 AI 生成日程、为每个活动创建 `once` 类型的 automation job、同步执行状态到日程面板。前端在 ReadingView 中嵌入日程面板。

**Tech Stack:** TypeScript, Electron IPC, React, 现有 automation/memory/reading 模块

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|---|---|
| `packages/shared/src/types/routine.ts` | 所有日程类型定义 + IPC 通道 |
| `apps/sidecar/src/services/infra/config-paths.ts` (追加) | routine 数据目录路径 |
| `apps/sidecar/src/services/routine/routine-store.ts` | 日程数据的读写持久化 |
| `apps/sidecar/src/services/routine/routine-activities.ts` | 各活动类型的执行器定义 |
| `apps/sidecar/src/services/routine/routine-generator.ts` | 上下文收集 + AI 生成日程 |
| `apps/sidecar/src/services/routine/routine-executor.ts` | 创建 automation job + 状态同步 |
| `apps/sidecar/src/services/routine/routine-runner.ts` | 每日定时触发 + 启动/停止 |
| `apps/sidecar/src/rpc/routine-handlers.ts` | routine 专用 RPC handler |
| `apps/web/src/lib/desktop-api/routine.ts` | 前端 routine API 封装 |
| `apps/web/src/components/routine/RoutinePanel.tsx` | 日程面板主组件 |
| `apps/web/src/components/routine/RoutineEntryItem.tsx` | 单条日程条目组件 |

### 修改文件

| 文件 | 变更 |
|---|---|
| `apps/sidecar/src/index.ts` | 启动 routine-runner 替代 cadence runner |
| `apps/sidecar/src/rpc/index.ts` | 注册 routine-handlers |
| `apps/sidecar/src/services/reading/reading-store.ts` | 新增 `autoAdvanceProgress`、`autoPickNextBook` |
| `apps/web/src/components/reading/ReadingView.tsx` | 嵌入日程面板入口 |
| `apps/web/src/components/reading/reading-view-state.ts` | 新增日程面板状态 |

---

## Task 1: 共享类型定义

**Files:**
- Create: `packages/shared/src/types/routine.ts`
- Modify: `packages/shared/src/types/routine.ts`（确保被 index 导出）

- [ ] **Step 1: 创建 routine.ts 类型文件**

```typescript
// packages/shared/src/types/routine.ts

export type RoutineActivity =
  | "reading_note"
  | "reading_progress"
  | "memory_organize"
  | "data_sync"
  | "daily_summary"
  | "weekly_summary"
  | "todo_review"
  | "interest_digest"
  | "work_overview"

export type RoutineEntryStatus = "pending" | "running" | "completed" | "skipped" | "failed"
export type RoutineStatus = "planned" | "running" | "completed"

export interface RoutineResult {
  summary: string
  relatedIds?: string[]
}

export interface RoutineEntry {
  id: string
  activity: RoutineActivity
  scheduledAt: number
  status: RoutineEntryStatus
  automationJobId?: string
  result?: RoutineResult
}

export interface RoutineContext {
  activeBooks: number
  unfinishedTodos: number
  lastSyncAt?: number
  dayOfWeek: number
  recentNotes: number
  pendingMemories: number
}

export interface DailyRoutine {
  id: string
  date: string
  generatedAt: number
  status: RoutineStatus
  entries: RoutineEntry[]
  context: RoutineContext
}

export const ROUTINE_IPC_CHANNELS = {
  GET_TODAY: "routine:get-today",
  TRIGGER_ENTRY: "routine:trigger-entry",
  REGENERATE: "routine:regenerate",
} as const
```

- [ ] **Step 2: 确认 routine.ts 被 packages/shared 导出**

检查 `packages/shared/src/types/index.ts`（或对应的 barrel 文件），确保 `routine.ts` 被导出。如果类型文件是自动导出的（通过 glob），跳过此步。否则添加：

```typescript
export * from "./routine"
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json`
Expected: 无新增错误

- [ ] **Step 4: 提交**

```bash
git add packages/shared/src/types/routine.ts
git commit -m "feat(routine): add shared type definitions for daily routine system"
```

---

## Task 2: 配置路径 + 存储层

**Files:**
- Modify: `apps/sidecar/src/services/infra/config-paths.ts`
- Create: `apps/sidecar/src/services/routine/routine-store.ts`

- [ ] **Step 1: 在 config-paths.ts 追加 routine 目录函数**

在文件末尾（其他 `getXxxDir` 函数之后）添加：

```typescript
export function getRoutineDir(): string {
  return ensureDir(join(getConfigDir(), "routine"), "日程数据目录");
}

export function getRoutineSchedulesDir(): string {
  return ensureDir(join(getRoutineDir(), "schedules"), "日程表目录");
}

export function getRoutineSchedulePath(date: string): string {
  return join(getRoutineSchedulesDir(), `${date}.json`);
}

export function getRoutineRunsPath(): string {
  return join(getRoutineDir(), "runs.jsonl");
}
```

- [ ] **Step 2: 创建 routine-store.ts**

```typescript
// apps/sidecar/src/services/routine/routine-store.ts

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import type { DailyRoutine, RoutineEntry, RoutineEntryStatus, RoutineStatus } from "@lume/shared"
import { getRoutineSchedulePath, getRoutineRunsPath } from "../infra/config-paths"

export function readRoutine(date: string): DailyRoutine | null {
  const path = getRoutineSchedulePath(date)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DailyRoutine
  } catch {
    return null
  }
}

export function writeRoutine(routine: DailyRoutine): void {
  const path = getRoutineSchedulePath(routine.date)
  writeFileSync(path, JSON.stringify(routine, null, 2), "utf-8")
}

export function updateEntryStatus(
  date: string,
  entryId: string,
  status: RoutineEntryStatus,
  result?: { summary: string; relatedIds?: string[] }
): DailyRoutine | null {
  const routine = readRoutine(date)
  if (!routine) return null
  const entry = routine.entries.find((e) => e.id === entryId)
  if (!entry) return null
  entry.status = status
  if (result) {
    entry.result = result
  }
  routine.status = deriveRoutineStatus(routine.entries)
  writeRoutine(routine)
  return routine
}

export function updateRoutineStatus(date: string, status: RoutineStatus): DailyRoutine | null {
  const routine = readRoutine(date)
  if (!routine) return null
  routine.status = status
  writeRoutine(routine)
  return routine
}

export function appendRoutineRun(record: { entryId: string; activity: string; status: string; completedAt: number }): void {
  const path = getRoutineRunsPath()
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8")
}

function deriveRoutineStatus(entries: RoutineEntry[]): RoutineStatus {
  if (entries.every((e) => e.status === "completed" || e.status === "skipped" || e.status === "failed")) {
    return "completed"
  }
  if (entries.some((e) => e.status === "running")) {
    return "running"
  }
  return "planned"
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误（可能有预存的无关错误）

- [ ] **Step 4: 提交**

```bash
git add apps/sidecar/src/services/infra/config-paths.ts apps/sidecar/src/services/routine/routine-store.ts
git commit -m "feat(routine): add config paths and routine data store"
```

---

## Task 3: 活动执行器定义

**Files:**
- Create: `apps/sidecar/src/services/routine/routine-activities.ts`

- [ ] **Step 1: 创建活动执行器**

```typescript
// apps/sidecar/src/services/routine/routine-activities.ts

import type { AutomationCreateJobInput } from "@lume/shared"
import type { RoutineActivity, RoutineContext, RoutineEntry } from "@lume/shared"

export interface RoutineActivityExecutor {
  activity: RoutineActivity
  shouldInclude(context: RoutineContext): boolean
  buildJobInput(entry: RoutineEntry, context: RoutineContext): AutomationCreateJobInput
  estimatedMinutes: number
}

const executors: RoutineActivityExecutor[] = [
  {
    activity: "data_sync",
    shouldInclude(ctx) {
      return ctx.lastSyncAt == null || Date.now() - ctx.lastSyncAt >= 6 * 3600_000
    },
    buildJobInput(_entry, _ctx) {
      return {
        name: "数据同步",
        prompt: "执行微信读书数据同步：同步书架、更新进度、刷新划线和书签。完成后简要汇报同步了哪些数据。",
        schedule: { type: "once", runAt: _entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 2,
  },
  {
    activity: "reading_progress",
    shouldInclude(ctx) {
      return ctx.activeBooks > 0
    },
    buildJobInput(_entry, _ctx) {
      return {
        name: "读书进度推进",
        prompt: "推进当前在读书籍的阅读进度。使用 lume_reading_snapshot 查看当前在读的书，为每本书按比例推进 progressPercent（模拟每日阅读进度）。如果某本书进度达到 100%，标记为 finished。完成后简要汇报进度变化。",
        schedule: { type: "once", runAt: _entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 1,
  },
  {
    activity: "reading_note",
    shouldInclude(ctx) {
      return ctx.activeBooks > 0 && ctx.recentNotes < 4
    },
    buildJobInput(_entry, _ctx) {
      return {
        name: "读书笔记",
        prompt: "为当前在读的一本书生成一篇读书笔记。使用 lume_reading_snapshot 查看书籍列表，选择一本合适的书，然后调用 lume_write_reading_note 生成笔记。笔记深度根据当前上下文决定。",
        schedule: { type: "once", runAt: _entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 2,
  },
  {
    activity: "memory_organize",
    shouldInclude(ctx) {
      return ctx.pendingMemories > 0
    },
    buildJobInput(_entry, _ctx) {
      return {
        name: "记忆整理",
        prompt: "整理近期记忆。查看最近的对话和记忆条目，提取关键事实，去重、分类、写入记忆系统。完成后简要汇报整理了哪些记忆。",
        schedule: { type: "once", runAt: _entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 3,
  },
  {
    activity: "todo_review",
    shouldInclude(ctx) {
      return ctx.unfinishedTodos > 0
    },
    buildJobInput(_entry, _ctx) {
      return {
        name: "待办提醒",
        prompt: "检查用户对话中提取的待办事项。搜索记忆中的待办条目，按优先级排序，生成一份待办提醒列表。如果所有待办都已完成，简要确认即可。",
        schedule: { type: "once", runAt: _entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 1,
  },
  {
    activity: "interest_digest",
    shouldInclude(_ctx) {
      return false // 首版暂不实现，需要兴趣标签配置
    },
    buildJobInput(_entry, _ctx) {
      return {
        name: "兴趣资讯",
        prompt: "根据用户兴趣搜索并聚合资讯，筛选 3-5 条推荐。",
        schedule: { type: "once", runAt: _entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 2,
  },
  {
    activity: "work_overview",
    shouldInclude(ctx) {
      return ctx.dayOfWeek >= 1 && ctx.dayOfWeek <= 5
    },
    buildJobInput(_entry, _ctx) {
      return {
        name: "工作概览",
        prompt: "生成今日工作概览。检查近期 git 提交、项目状态，生成一份简短的工作日报。",
        schedule: { type: "once", runAt: _entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 2,
  },
  {
    activity: "daily_summary",
    shouldInclude(_ctx) {
      return true // 始终包含，作为当天最后一个活动
    },
    buildJobInput(_entry, _ctx) {
      return {
        name: "每日总结",
        prompt: "汇总今天的日程执行结果。查看今天完成了哪些活动，生成一段简短的每日总结。",
        schedule: { type: "once", runAt: _entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 1,
  },
  {
    activity: "weekly_summary",
    shouldInclude(ctx) {
      return ctx.dayOfWeek === 0
    },
    buildJobInput(_entry, _ctx) {
      return {
        name: "每周总结",
        prompt: "生成本周总结。汇总本周读书进度、笔记数量、记忆增长、待办完成情况，输出一篇结构化的周报。",
        schedule: { type: "once", runAt: _entry.scheduledAt },
        enabled: true,
      }
    },
    estimatedMinutes: 3,
  },
]

export function getActivityExecutor(activity: RoutineActivity): RoutineActivityExecutor | undefined {
  return executors.find((e) => e.activity === activity)
}

export function getApplicableActivities(context: RoutineContext): RoutineActivityExecutor[] {
  return executors.filter((e) => e.shouldInclude(context))
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add apps/sidecar/src/services/routine/routine-activities.ts
git commit -m "feat(routine): define activity executors for all routine types"
```

---

## Task 4: 日程生成器

**Files:**
- Create: `apps/sidecar/src/services/routine/routine-generator.ts`

- [ ] **Step 1: 创建日程生成器**

```typescript
// apps/sidecar/src/services/routine/routine-generator.ts

import { randomUUID } from "node:crypto"
import type { DailyRoutine, RoutineContext, RoutineEntry, RoutineActivity } from "@lume/shared"
import { listReadingBooks } from "../reading/reading-store"
import { getReadingSettings, listReadingNotes } from "../reading/reading-store"
import { getApplicableActivities } from "./routine-activities"
import { writeRoutine, readRoutine } from "./routine-store"

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function collectRoutineContext(): RoutineContext {
  const now = Date.now()
  const books = listReadingBooks()
  const activeBooks = books.filter((b) => b.status !== "finished").length
  const notes = listReadingNotes({ includeHidden: true })
  const recentNotes = notes.filter((n) => now - n.createdAt < 7 * 86400_000).length
  const settings = getReadingSettings()

  return {
    activeBooks,
    unfinishedTodos: 0, // TODO: 从记忆/对话中提取待办数
    lastSyncAt: settings.weread.lastSyncAt,
    dayOfWeek: new Date().getDay(),
    recentNotes,
    pendingMemories: 0, // TODO: 从 memory-v2 获取待整理数
  }
}

function buildTimeSlots(date: string): number[] {
  // 从当天 8:00 到 21:00，每小时一个 slot
  const base = new Date(date).getTime()
  const slots: number[] = []
  for (let hour = 8; hour <= 21; hour++) {
    slots.push(base + hour * 3600_000)
  }
  return slots
}

function assignSchedule(entries: RoutineEntry[], context: RoutineContext): RoutineEntry[] {
  const slots = buildTimeSlots(today())
  let slotIndex = 0

  // 按优先级排序：data_sync 最先，daily_summary 最后
  const priorityOrder: RoutineActivity[] = [
    "data_sync",
    "memory_organize",
    "work_overview",
    "reading_progress",
    "reading_note",
    "todo_review",
    "interest_digest",
    "weekly_summary",
    "daily_summary",
  ]

  const sorted = [...entries].sort((a, b) => {
    return priorityOrder.indexOf(a.activity) - priorityOrder.indexOf(b.activity)
  })

  return sorted.map((entry) => {
    entry.scheduledAt = slots[Math.min(slotIndex, slots.length - 1)]
    slotIndex++
    return entry
  })
}

export function generateDailyRoutine(overrideDate?: string): DailyRoutine {
  const date = overrideDate ?? today()

  // 如果已存在则跳过
  const existing = readRoutine(date)
  if (existing) return existing

  const context = collectRoutineContext()
  const applicable = getApplicableActivities(context)

  let entries: RoutineEntry[] = applicable.map((executor, index) => ({
    id: `entry-${executor.activity}-${index}`,
    activity: executor.activity,
    scheduledAt: 0,
    status: "pending" as const,
  }))

  entries = assignSchedule(entries, context)

  const routine: DailyRoutine = {
    id: `routine-${date}`,
    date,
    generatedAt: Date.now(),
    status: "planned",
    entries,
    context,
  }

  writeRoutine(routine)
  return routine
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add apps/sidecar/src/services/routine/routine-generator.ts
git commit -m "feat(routine): add daily routine generator with context-aware scheduling"
```

---

## Task 5: 执行调度器

**Files:**
- Create: `apps/sidecar/src/services/routine/routine-executor.ts`

- [ ] **Step 1: 创建执行调度器**

```typescript
// apps/sidecar/src/services/routine/routine-executor.ts

import type { DailyRoutine, RoutineEntry } from "@lume/shared"
import { createAutomationJob, listAutomationJobs } from "../automation/automation-manager"
import { startAutomationRunner, refreshAutomationRunnerJobs } from "../automation/automation-runner-service"
import { getActivityExecutor } from "./routine-activities"
import { readRoutine, writeRoutine, updateEntryStatus, appendRoutineRun } from "./routine-store"

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 为日程中的每个 pending entry 创建 automation job
 */
export async function scheduleRoutineEntries(routine: DailyRoutine): Promise<DailyRoutine> {
  await startAutomationRunner()

  for (const entry of routine.entries) {
    if (entry.status !== "pending" || entry.automationJobId) continue

    const executor = getActivityExecutor(entry.activity)
    if (!executor) {
      entry.status = "skipped"
      continue
    }

    try {
      const jobInput = executor.buildJobInput(entry, routine.context)
      const job = createAutomationJob(jobInput)
      entry.automationJobId = job.id
    } catch {
      entry.status = "failed"
    }
  }

  await refreshAutomationRunnerJobs()
  writeRoutine(routine)
  return routine
}

/**
 * 手动触发某个 entry（立即执行）
 */
export async function triggerRoutineEntry(entryId: string): Promise<DailyRoutine | null> {
  const date = today()
  const routine = readRoutine(date)
  if (!routine) return null

  const entry = routine.entries.find((e) => e.id === entryId)
  if (!entry) return null

  const executor = getActivityExecutor(entry.activity)
  if (!executor) return null

  // 如果已有 job 且已 disabled（once 类型执行完会 disable），先创建新的
  const jobInput = executor.buildJobInput({ ...entry, scheduledAt: Date.now() }, routine.context)
  const job = createAutomationJob(jobInput)
  entry.automationJobId = job.id

  await refreshAutomationRunnerJobs()
  writeRoutine(routine)
  return routine
}

/**
 * 同步 automation job 状态到 routine entry
 * 由 runner 定期调用
 */
export function syncRoutineStatus(): void {
  const date = today()
  const routine = readRoutine(date)
  if (!routine || routine.status === "completed") return

  const jobs = listAutomationJobs()

  for (const entry of routine.entries) {
    if (!entry.automationJobId || entry.status === "completed" || entry.status === "failed") continue

    const job = jobs.find((j) => j.id === entry.automationJobId)
    if (!job) continue

    // once 类型执行完会被 disabled
    if (!job.enabled && job.lastRunAt) {
      entry.status = "completed"
      appendRoutineRun({
        entryId: entry.id,
        activity: entry.activity,
        status: "completed",
        completedAt: Date.now(),
      })
    }
  }

  // 更新整体状态
  const allDone = routine.entries.every(
    (e) => e.status === "completed" || e.status === "skipped" || e.status === "failed"
  )
  if (allDone) {
    routine.status = "completed"
  } else if (routine.entries.some((e) => e.status === "running")) {
    routine.status = "running"
  }

  writeRoutine(routine)
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add apps/sidecar/src/services/routine/routine-executor.ts
git commit -m "feat(routine): add routine executor that delegates to automation jobs"
```

---

## Task 6: 日程 Runner

**Files:**
- Create: `apps/sidecar/src/services/routine/routine-runner.ts`

- [ ] **Step 1: 创建 runner**

```typescript
// apps/sidecar/src/services/routine/routine-runner.ts

import { generateDailyRoutine } from "./routine-generator"
import { scheduleRoutineEntries } from "./routine-executor"
import { syncRoutineStatus } from "./routine-executor"
import { readRoutine } from "./routine-store"

const ROUTINE_GENERATE_HOUR = 8
const SYNC_INTERVAL_MS = 5 * 60 * 1000 // 5 分钟同步一次

let generateTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let runnerStarted = false

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function scheduleNextGeneration(): void {
  if (generateTimer) {
    clearTimeout(generateTimer)
    generateTimer = null
  }

  const now = new Date()
  const target = new Date(now)
  target.setHours(ROUTINE_GENERATE_HOUR, 0, 0, 0)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  const delay = target.getTime() - now.getTime()

  generateTimer = setTimeout(async () => {
    try {
      await runDailyGeneration()
    } catch (error) {
      console.error("[日程] 日程生成失败:", error instanceof Error ? error.message : String(error))
    }
    scheduleNextGeneration()
  }, delay)

  console.log(`[日程] 下次生成时间: ${target.toLocaleString("zh-CN")}`)
}

async function runDailyGeneration(): Promise<void> {
  console.log("[日程] 开始生成今日日程")
  const routine = generateDailyRoutine()
  await scheduleRoutineEntries(routine)
  console.log(`[日程] 已生成 ${routine.entries.length} 个活动`)
}

export async function startRoutineRunner(): Promise<void> {
  if (runnerStarted) return
  runnerStarted = true

  // 检查今天是否已生成
  const date = today()
  const existing = readRoutine(date)
  if (!existing) {
    // 未生成，立即生成
    await runDailyGeneration()
  } else if (existing.status === "planned") {
    // 已生成但未完成，恢复调度
    await scheduleRoutineEntries(existing)
  }

  // 注册每日生成定时器
  scheduleNextGeneration()

  // 注册状态同步定时器
  syncTimer = setInterval(() => {
    try {
      syncRoutineStatus()
    } catch (error) {
      console.error("[日程] 状态同步失败:", error instanceof Error ? error.message : String(error))
    }
  }, SYNC_INTERVAL_MS)
}

export function stopRoutineRunner(): void {
  runnerStarted = false
  if (generateTimer) {
    clearTimeout(generateTimer)
    generateTimer = null
  }
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add apps/sidecar/src/services/routine/routine-runner.ts
git commit -m "feat(routine): add routine runner with daily generation and status sync"
```

---

## Task 7: Reading Store 扩展

**Files:**
- Modify: `apps/sidecar/src/services/reading/reading-store.ts`

- [ ] **Step 1: 添加 autoAdvanceProgress 函数**

在 `reading-store.ts` 中（`recordReadingBookProgress` 函数之后）添加：

```typescript
export function autoAdvanceProgress(): { bookId: string; title: string; oldProgress: number; newProgress: number }[] {
  initReadingStorage()
  const library = readLibrary()
  const now = Date.now()
  const results: { bookId: string; title: string; oldProgress: number; newProgress: number }[] = []

  for (const book of library.books) {
    if (book.status === "finished") continue

    const currentProgress = typeof book.progressPercent === "number" ? book.progressPercent : 0
    // 基于预估时长推算每日进度，假设每本书 14 天读完
    const dailyIncrement = 100 / 14
    const newProgress = Math.min(100, Math.round((currentProgress + dailyIncrement) * 10) / 10)

    book.progressPercent = newProgress
    book.updatedAt = now

    if (newProgress >= 100) {
      book.status = "finished"
    }

    results.push({
      bookId: book.id,
      title: book.title,
      oldProgress: currentProgress,
      newProgress,
    })
  }

  if (results.length > 0) {
    writeLibrary(library)
  }
  return results
}
```

- [ ] **Step 2: 添加 autoPickNextBook 函数**

在 `autoAdvanceProgress` 之后添加：

```typescript
export function autoPickNextBook(): ReadingBook | null {
  initReadingStorage()
  const library = readLibrary()
  const activeBooks = library.books.filter((b) => b.status !== "finished")

  if (activeBooks.length > 0) return null

  // 找最近读完的书
  const finishedBooks = library.books
    .filter((b) => b.status === "finished" && b.updatedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const lastFinished = finishedBooks[0]
  const daysSinceFinish = lastFinished
    ? (Date.now() - lastFinished.updatedAt) / (24 * 3600_000)
    : Infinity

  if (daysSinceFinish < 2) return null

  // 选择一本 queued 状态的书，或最近的 finished 书重新标记为 reading
  const queuedBook = library.books.find((b) => b.status === "queued")
  if (queuedBook) {
    queuedBook.status = "reading"
    queuedBook.progressPercent = 0
    queuedBook.updatedAt = Date.now()
    writeLibrary(library)
    return normalizeReadingBook(queuedBook)
  }

  return null
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 4: 提交**

```bash
git add apps/sidecar/src/services/reading/reading-store.ts
git commit -m "feat(reading): add autoAdvanceProgress and autoPickNextBook for routine system"
```

---

## Task 8: RPC Handler + 启动集成

**Files:**
- Create: `apps/sidecar/src/rpc/routine-handlers.ts`
- Modify: `apps/sidecar/src/rpc/index.ts`
- Modify: `apps/sidecar/src/index.ts`

- [ ] **Step 1: 创建 routine-handlers.ts**

```typescript
// apps/sidecar/src/rpc/routine-handlers.ts

import { ROUTINE_IPC_CHANNELS } from "@lume/shared"
import type { RpcHandler } from "./types"
import { readRoutine } from "../services/routine/routine-store"
import { generateDailyRoutine } from "../services/routine/routine-generator"
import { triggerRoutineEntry, syncRoutineStatus } from "../services/routine/routine-executor"

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function createRoutineHandlers(): Record<string, RpcHandler> {
  return {
    [ROUTINE_IPC_CHANNELS.GET_TODAY]: async () => {
      syncRoutineStatus()
      return readRoutine(today())
    },

    [ROUTINE_IPC_CHANNELS.TRIGGER_ENTRY]: async (params) => {
      const { entryId } = params as { entryId: string }
      if (!entryId) throw new Error("entryId 不能为空")
      return triggerRoutineEntry(entryId)
    },

    [ROUTINE_IPC_CHANNELS.REGENERATE]: async () => {
      const date = today()
      // 删除旧的未执行日程，重新生成
      const existing = readRoutine(date)
      if (existing) {
        // TODO: 取消已有的 automation jobs
      }
      const routine = generateDailyRoutine(date)
      return routine
    },
  }
}
```

- [ ] **Step 2: 在 rpc/index.ts 注册 routine handlers**

找到 `createReadingHandlers` 所在的 `Object.assign(handlers, ...)` 调用，添加 `createRoutineHandlers()`：

```typescript
// 在现有的 Object.assign 调用中追加
createRoutineHandlers(),
```

需要确保 import 也添加：
```typescript
import { createRoutineHandlers } from "./routine-handlers"
```

- [ ] **Step 3: 在 sidecar index.ts 替换 cadence runner**

找到这段代码：

```typescript
if (envAutostartEnabled("LUME_READING_RUNNER_AUTOSTART", true)) {
  setReadingCadenceNotificationWriter(writeNotification);
  void startReadingCadenceRunner().catch((error) => {
    console.error(`[读书 Runner] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
  });
}
```

替换为：

```typescript
if (envAutostartEnabled("LUME_READING_RUNNER_AUTOSTART", true)) {
  const { startRoutineRunner } = await import("./services/routine/routine-runner");
  void startRoutineRunner().catch((error) => {
    console.error(`[日程 Runner] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
  });
}
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 5: 提交**

```bash
git add apps/sidecar/src/rpc/routine-handlers.ts apps/sidecar/src/rpc/index.ts apps/sidecar/src/index.ts
git commit -m "feat(routine): add RPC handlers and integrate routine runner into sidecar boot"
```

---

## Task 9: 前端 API 封装

**Files:**
- Create: `apps/web/src/lib/desktop-api/routine.ts`

- [ ] **Step 1: 创建前端 API**

```typescript
// apps/web/src/lib/desktop-api/routine.ts

import type { DailyRoutine } from "@lume/shared"
import { ROUTINE_IPC_CHANNELS } from "@lume/shared"
import { sidecarCall } from "./sidecar"

export const getRoutineToday = () =>
  sidecarCall<DailyRoutine | null>(ROUTINE_IPC_CHANNELS.GET_TODAY)

export const triggerRoutineEntry = (entryId: string) =>
  sidecarCall<DailyRoutine | null>(ROUTINE_IPC_CHANNELS.TRIGGER_ENTRY, { entryId })

export const regenerateRoutine = () =>
  sidecarCall<DailyRoutine>(ROUTINE_IPC_CHANNELS.REGENERATE)
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/lib/desktop-api/routine.ts
git commit -m "feat(routine): add frontend desktop API for routine system"
```

---

## Task 10: 日程面板 UI

**Files:**
- Create: `apps/web/src/components/routine/RoutineEntryItem.tsx`
- Create: `apps/web/src/components/routine/RoutinePanel.tsx`
- Modify: `apps/web/src/components/reading/ReadingView.tsx`
- Modify: `apps/web/src/components/reading/reading-view-state.ts`

- [ ] **Step 1: 创建 RoutineEntryItem.tsx**

```tsx
// apps/web/src/components/routine/RoutineEntryItem.tsx

import type { RoutineEntry, RoutineActivity } from "@lume/shared"
import { cn } from "../lib/utils"

const ACTIVITY_LABELS: Record<RoutineActivity, string> = {
  reading_note: "读书笔记",
  reading_progress: "读书进度",
  memory_organize: "记忆整理",
  data_sync: "数据同步",
  daily_summary: "每日总结",
  weekly_summary: "每周总结",
  todo_review: "待办提醒",
  interest_digest: "兴趣资讯",
  work_overview: "工作概览",
}

const STATUS_ICONS: Record<RoutineEntry["status"], string> = {
  pending: "☐",
  running: "⟳",
  completed: "✅",
  skipped: "—",
  failed: "❌",
}

interface RoutineEntryItemProps {
  entry: RoutineEntry
  onTrigger?: (entryId: string) => void
}

export function RoutineEntryItem({ entry, onTrigger }: RoutineEntryItemProps) {
  const time = new Date(entry.scheduledAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })
  const label = ACTIVITY_LABELS[entry.activity] ?? entry.activity
  const icon = STATUS_ICONS[entry.status]
  const isClickable = entry.status === "pending" || entry.status === "failed"

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors",
        entry.status === "completed" && "text-[var(--text-3)]",
        entry.status === "skipped" && "text-[var(--text-3)] line-through",
        entry.status === "running" && "text-blue-500",
        entry.status === "failed" && "text-red-400",
        isClickable && "cursor-pointer hover:bg-[var(--surface-2)]",
      )}
      onClick={() => isClickable && onTrigger?.(entry.id)}
    >
      <span className="w-5 text-center">{entry.status === "running" ? <span className="animate-spin">⟳</span> : icon}</span>
      <span className="text-[var(--text-3)]">{time}</span>
      <span className="flex-1">{label}</span>
      {entry.result && (
        <span className="truncate text-[11px] text-[var(--text-3)]">{entry.result.summary}</span>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 创建 RoutinePanel.tsx**

```tsx
// apps/web/src/components/routine/RoutinePanel.tsx

import { useCallback, useEffect, useState } from "react"
import type { DailyRoutine } from "@lume/shared"
import { getRoutineToday, triggerRoutineEntry, regenerateRoutine } from "../../lib/desktop-api/routine"
import { RoutineEntryItem } from "./RoutineEntryItem"

export function RoutinePanel() {
  const [routine, setRoutine] = useState<DailyRoutine | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const result = await getRoutineToday()
      setRoutine(result)
    } catch (error) {
      console.error("[RoutinePanel] 加载失败:", error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

  const handleTrigger = useCallback(async (entryId: string) => {
    try {
      const result = await triggerRoutineEntry(entryId)
      setRoutine(result)
    } catch (error) {
      console.error("[RoutinePanel] 触发失败:", error)
    }
  }, [])

  const handleRegenerate = useCallback(async () => {
    setLoading(true)
    try {
      const result = await regenerateRoutine()
      setRoutine(result)
    } catch (error) {
      console.error("[RoutinePanel] 重新生成失败:", error)
    } finally {
      setLoading(false)
    }
  }, [])

  if (loading) {
    return <div className="p-6 text-[13px] text-[var(--text-3)]">加载日程中...</div>
  }

  if (!routine) {
    return <div className="p-6 text-[13px] text-[var(--text-3)]">今日暂无日程</div>
  }

  const pending = routine.entries.filter((e) => e.status === "pending")
  const done = routine.entries.filter((e) => e.status !== "pending")

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-semibold">📅 今日日程</h2>
        <span className="text-[12px] text-[var(--text-3)]">
          {routine.date} {done.length}/{routine.entries.length} 已完成
        </span>
      </div>

      {pending.length > 0 && (
        <div className="flex flex-col gap-1">
          {pending.map((entry) => (
            <RoutineEntryItem key={entry.id} entry={entry} onTrigger={handleTrigger} />
          ))}
        </div>
      )}

      {done.length > 0 && (
        <>
          <div className="border-t border-[var(--reading-border)]" />
          <div className="flex flex-col gap-1">
            {done.map((entry) => (
              <RoutineEntryItem key={entry.id} entry={entry} onTrigger={handleTrigger} />
            ))}
          </div>
        </>
      )}

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={handleRegenerate}
          className="rounded-lg border border-[var(--reading-border)] px-3 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)]"
        >
          重新生成日程
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 在 ReadingView 中嵌入日程面板**

在 `ReadingView.tsx` 中：

1. 添加 import：
```typescript
import { RoutinePanel } from "../routine/RoutinePanel"
```

2. 在左侧 sidebar 的 rail items 之后、weread prompt 之前，添加日程入口：

```tsx
{/* 日程入口 */}
<button
  type="button"
  onClick={() => setSelectedId("__routine__")}
  className={cn(
    "flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left transition-colors",
    selectedId === "__routine__"
      ? "bg-[var(--reading-active)] text-[var(--text-1)]"
      : "text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]",
  )}
>
  <span className="text-[14px]">📅</span>
  <span className="truncate text-[12px] font-normal">今日日程</span>
</button>
```

3. 在主内容区，当 `selectedId === "__routine__"` 时显示 `RoutinePanel`：

在 `<main>` 标签内的现有内容之前添加：

```tsx
{selectedId === "__routine__" && <RoutinePanel />}
{!selectedWereadBook && selectedId !== "__routine__" && (
  // ... 现有内容
)}
```

同时需要调整后续的条件判断，确保 `__routine__` 选中时不显示其他面板。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/routine/ apps/web/src/components/reading/ReadingView.tsx
git commit -m "feat(routine): add routine panel UI embedded in reading view"
```

---

## Task 11: 清理旧 Cadence Runner

**Files:**
- No delete needed, just ensure it's not started anymore (handled in Task 8)

- [ ] **Step 1: 验证旧 runner 不再启动**

确认 `apps/sidecar/src/index.ts` 中不再调用 `startReadingCadenceRunner`（在 Task 8 中已替换）。旧的 `reading-cadence-runner.ts` 文件保留但不再被调用，后续可以清理。

- [ ] **Step 2: 全量类型检查**

Run: `npx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Run: `npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: 无新增错误

- [ ] **Step 3: 最终提交**

```bash
git add -A
git commit -m "chore(routine): verify old cadence runner replaced, full type check passes"
```
