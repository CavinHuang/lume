# Lume 日程系统设计

> 日期：2026-06-08
> 状态：已确认

## 概述

为 Lume 设计一套日程系统，每天由 AI 动态生成当日日程表，涵盖读书笔记、记忆整理、周期总结等活动。替代现有的固定间隔读书节奏 runner，让 Lume 的自动化行为从「定时闹钟」变为「每天自然发生」。

核心思路：复用现有 Automation 调度引擎，日程系统作为编排层，负责「今天做什么、什么时间做」，执行委托给 automation。

## 设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 系统形态 | 日程面板 + 自动执行 | 用户可查看干预，后台自动执行 |
| 日程生成 | AI 动态生成 | 类似 Alice，根据上下文灵活调整 |
| 执行结果展示 | 面板状态 + 可查看结果 | 不打扰，但可查 |
| 提醒方式 | 纯被动（只在日程面板） | 不打断用户 |
| 读书进度 | 自动推进 + 自动换书 | 保持阅读节奏 |
| 日程粒度 | 带时间线（日程表） | 比纯清单更直观 |
| 实施范围 | 一步到位 | 所有活动类型全部纳入 |
| 技术方案 | 复用现有 Automation 系统 | 不造新轮子 |
| 数据存储 | 独立 routine 目录 | 与 reading 数据分离 |

---

## §1 核心概念与数据模型

### 日程表（Daily Routine）

每天早上由 AI 生成一份日程表，存为一条记录。

```typescript
interface DailyRoutine {
  id: string                    // "routine-2026-06-08"
  date: string                  // "2026-06-08"
  generatedAt: number           // 生成时间戳
  status: "planned" | "running" | "completed"
  entries: RoutineEntry[]       // 当天的活动条目
  context: RoutineContext       // AI 生成时的上下文快照
}

interface RoutineEntry {
  id: string                    // "entry-reading_note-1"
  activity: RoutineActivity     // 活动类型
  scheduledAt: number           // 计划执行时间
  status: "pending" | "running" | "completed" | "skipped" | "failed"
  automationJobId?: string      // 关联的 automation job id
  result?: RoutineResult        // 执行结果
}

type RoutineActivity =
  | "reading_note"              // 读书笔记
  | "reading_progress"          // 读书进度推进
  | "memory_organize"           // 记忆整理
  | "data_sync"                 // 数据同步
  | "daily_summary"             // 每日总结
  | "weekly_summary"            // 周期总结
  | "todo_review"               // 待办提醒
  | "interest_digest"           // 兴趣资讯
  | "work_overview"             // 工作概览

interface RoutineResult {
  summary: string               // 结果摘要
  relatedIds?: string[]         // 关联资源 id（笔记 id、记忆 id 等）
}

interface RoutineContext {
  activeBooks: number           // 在读书数量
  unfinishedTodos: number       // 未完成待办
  lastSyncAt?: number           // 上次同步时间
  dayOfWeek: number             // 星期几
  recentNotes: number           // 近 7 天笔记数
  pendingMemories: number       // 待整理记忆数
}
```

### 关键设计点

1. **一天一条记录**：按日期存储，id 格式 `routine-YYYY-MM-DD`
2. **每个 entry 关联一个 automation job**：执行委托给现有引擎
3. **context 是快照**：AI 生成时拍一张，用于理解为什么安排了这些活动
4. **状态流转**：`planned` → `running`（第一个 entry 开始）→ `completed`（所有 entry 结束）

---

## §2 日程生成流程

### 每日生成时机

定时器每天早上固定时间触发，默认 8:00。

```typescript
const ROUTINE_GENERATE_HOUR = 8

async function generateDailyRoutine(): Promise<DailyRoutine> {
  // 1. 收集上下文
  const context = await collectRoutineContext()

  // 2. 调用 AI 生成日程
  const entries = await generateRoutineEntries(context)

  // 3. 为每个 entry 创建 automation job
  for (const entry of entries) {
    const job = await createRoutineAutomationJob(entry)
    entry.automationJobId = job.id
  }

  // 4. 存储
  return saveRoutine({ date: today(), entries, context, status: "planned" })
}
```

### 上下文收集

AI 生成日程前，收集以下信息作为决策依据：

- `activeBooks`：当前在读的书数量
- `unfinishedTodos`：未完成的待办事项数
- `lastSyncAt`：上次微信读书同步时间
- `dayOfWeek`：星期几
- `recentNotes`：近 7 天生成的笔记数
- `pendingMemories`：待整理的记忆条目数

### AI Prompt 策略

AI 拿到上下文后决定：
- **今天该做哪些活动**（不是每天都做全部活动）
- **每个活动安排在什么时间**
- **跳过不适用的活动**（没有未读记忆就不安排记忆整理）

核心原则：
- 有书在读 → 安排读书笔记 + 进度推进
- 有待整理记忆 → 安排记忆整理
- 周日 → 安排周报
- 每月最后一天 → 安排月报
- 有微信读书连接 → 定期数据同步
- 有未完成待办 → 安排待办提醒

### 自动换书

```typescript
async function autoPickNextBook(): Promise<void> {
  const activeBooks = getActiveReadingBooks()  // status !== "finished"
  if (activeBooks.length > 0) return

  const lastFinished = getRecentlyFinishedBooks()[0]
  const daysSinceFinish = lastFinished
    ? (Date.now() - lastFinished.lastReadAt) / DAY_MS
    : Infinity

  if (daysSinceFinish >= 2) {
    await pickNewReadingBook()
  }
}
```

### 执行 → 日程状态同步

automation job 执行时，回调更新对应 entry 的状态：

- job 开始 → `entry.status = "running"`
- job 完成 → `entry.status = "completed"`，`entry.result = ...`
- job 失败 → `entry.status = "failed"`

---

## §3 各活动类型的执行逻辑

每种活动对应一个执行器，统一接口：

```typescript
interface RoutineActivityExecutor {
  activity: RoutineActivity
  shouldInclude(context: RoutineContext): boolean  // 今天是否需要
  createJobInput(entry: RoutineEntry, context: RoutineContext): AutomationJobInput
}
```

### 各活动详情

**① 读书进度推进 (`reading_progress`)**
- `shouldInclude`：有 `status === 'reading'` 的书
- 执行：为每本在读的书按比例推进 progress（基于书的总时长估算每日进度）
- 进度 ≥ 100% → 标记 `finished`，触发自动换书检查
- 不消耗 AI 调用，纯数据操作

**② 读书笔记生成 (`reading_note`)**
- `shouldInclude`：有在读的书 且 本周笔记数未达上限
- 执行：复用现有 `runReadingTaskAsync`
- depth 由 AI 根据上下文决定
- 每天 ≤ 1 篇，每周 ≤ 4 篇

**③ 记忆整理 (`memory_organize`)**
- `shouldInclude`：近 24 小时有新对话/新记忆条目
- 执行：AI 回顾近期对话，提取关键事实，去重、分类、写入 memory-v2
- 每天 ≤ 1 次

**④ 数据同步 (`data_sync`)**
- `shouldInclude`：微信读书已连接 且 距上次同步 ≥ 6 小时
- 执行：同步微信读书书架、更新进度、刷新划线/书签
- 不消耗 AI 调用

**⑤ 每日总结 (`daily_summary`)**
- `shouldInclude`：今天有其他活动执行完成
- 执行：晚间执行，汇总今天所有活动结果，生成简短总结
- 安排在当天最后一个活动之后

**⑥ 周期总结 (`weekly_summary`)**
- `shouldInclude`：`dayOfWeek === 0`（周日）
- 执行：汇总本周读书进度、笔记数量、记忆增长、待办完成情况
- 输出结构化周报

**⑦ 待办提醒 (`todo_review`)**
- `shouldInclude`：有未完成的待办事项
- 执行：检查对话中提取的待办，按优先级排序，生成提醒列表
- 轻度 AI 操作

**⑧ 兴趣资讯 (`interest_digest`)**
- `shouldInclude`：用户配置了兴趣标签
- 执行：根据兴趣标签搜索/聚合资讯，筛选 3-5 条推荐
- 需要 AI 做摘要

**⑨ 工作概览 (`work_overview`)**
- `shouldInclude`：工作日（周一到周五）
- 执行：检查 git 活跃、项目状态、近期代码提交，生成工作日报

### 频率控制

不再用固定的 `weekly / few_times_weekly`，改为 AI 每天根据上下文动态决定：

| 活动 | 频率上限 | 决策依据 |
|---|---|---|
| 读书进度推进 | 每天 | 只要有在读的书 |
| 读书笔记 | 每天 ≤ 1 篇，每周 ≤ 4 篇 | 有书在读 + 本周笔记数 |
| 记忆整理 | 每天 ≤ 1 次 | 有新对话/新记忆 |
| 数据同步 | 每天 ≤ 2 次 | 距上次同步时间 |
| 每日总结 | 每天 ≤ 1 次 | 今天有活动 |
| 周报 | 每周 ≤ 1 次 | 周日 |
| 待办提醒 | 每天 ≤ 1 次 | 有未完成待办 |
| 兴趣资讯 | 每天 ≤ 1 次 | 用户配置了兴趣 |
| 工作概览 | 工作日每天 ≤ 1 次 | 周一到周五 |

### 与现有 cadence runner 的关系

**完全替换** `reading-cadence-runner`。日程系统成为唯一的调度入口，原有 runner 不再启动。

---

## §4 日程面板 UI

### 位置与入口

在现有读书页面（ReadingView）左侧 sidebar 中新增日程入口按钮。点击后在主内容区显示日程面板。

### 面板布局

```
┌─────────────────────────────────────────────┐
│ 📅 今日日程                          6月8日 周日 │
├─────────────────────────────────────────────┤
│                                             │
│  ☐ 08:00  数据同步           · 预计 2 分钟    │
│  ☐ 09:00  记忆整理           · 预计 3 分钟    │
│  ☐ 10:00  读书笔记 · 人间词话  · 预计 1 分钟   │
│  ☐ 10:05  读书进度推进        · 预计 1 分钟    │
│  ☐ 14:00  兴趣资讯聚合        · 预计 2 分钟    │
│  ☐ 18:00  待办提醒           · 预计 1 分钟    │
│  ☐ 21:00  每日总结           · 预计 1 分钟    │
│                                             │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│  ✅ 08:00  数据同步           · 已完成         │
│  ✅ 09:00  记忆整理           · 已完成         │
│                                             │
│         [手动执行全部]  [重新生成日程]          │
└─────────────────────────────────────────────┘
```

### 状态展示

- **待执行（pending）**：空心复选框 `☐`，灰色文字
- **执行中（running）**：旋转图标 `⟳`，蓝色文字
- **已完成（completed）**：打勾 `✅`，灰色文字，可点击查看结果
- **跳过（skipped）**：划线，灰色
- **失败（failed）**：红色感叹号，可点击重试

### 交互操作

1. **点击已完成条目** → 弹出结果卡片（笔记内容/总结摘要/同步数据量）
2. **手动执行** → 点击单个条目立即执行，或「手动执行全部」
3. **重新生成** → 丢弃今日日程，AI 重新根据当前上下文生成

### IPC 通道

```typescript
export const ROUTINE_IPC_CHANNELS = {
  GET_TODAY: "routine:get-today",
  TRIGGER_ENTRY: "routine:trigger-entry",
  REGENERATE: "routine:regenerate",
} as const
```

---

## §5 存储与文件结构

### 存储位置

独立于 reading 目录，使用新的 routine 专用目录：

```
~/.lume/routine/
  schedules/
    2026-06-08.json        # 每天一个文件
    2026-06-07.json
  runs.jsonl               # 执行记录（追加写入）
```

### 新增文件清单

```
apps/sidecar/src/services/routine/
  routine-generator.ts       # 日程生成（上下文收集 + AI 调用）
  routine-executor.ts        # 执行调度（创建 automation job、状态同步）
  routine-activities.ts      # 各活动类型的执行器定义
  routine-store.ts           # 日程数据的读写持久化
  routine-runner.ts          # 每日定时触发 + 启动/停止

apps/sidecar/src/rpc/
  routine-handlers.ts        # 新增：routine 专用 RPC handler

apps/web/src/components/routine/
  RoutinePanel.tsx            # 日程面板主组件
  RoutineEntryItem.tsx        # 单条日程条目组件

packages/shared/src/types/
  routine.ts                  # 新增：所有日程相关类型 + IPC 通道
```

### 与现有代码的关系

| 现有模块 | 变更 |
|---|---|
| `reading-cadence-runner.ts` | **移除**，由 routine-runner 替代 |
| `reading-task-runner.ts` | **保留**，作为 `reading_note` 活动的执行后端 |
| `reading-store.ts` | **修改**，新增 `autoAdvanceProgress`、`autoPickNextBook` |
| `automation-runner-service.ts` | **保留**，作为执行引擎 |
| `index.ts`（sidecar） | **修改**，启动 routine-runner 替代 cadence runner |
| `rpc/index.ts` | **修改**，注册 routine-handlers |

### 启动流程

```
sidecar boot →
  stopReadingCadenceRunner()      // 停掉旧的
  startRoutineRunner()            // 启动新的
    → 检查今天的日程是否已生成
      → 没有：立即生成
      → 有且状态 planned：恢复调度
      → 有且状态 completed：不操作
    → 注册每日生成定时器（默认 8:00）
```

---

## 未覆盖 / 后续事项

- 兴趣标签的配置入口（需要单独设计设置页）
- 自动换书的选书策略（从搜索推荐？从微信读书书架？从种子书单？）
- 月报触发条件（月最后一天 vs 月初第一天）
- 历史日程的查看与回顾（首版只看当天）
