# Agent Automation Tools 设计文档

> 2026-06-12 — 让 Agent 能高效操作自动化任务和每日日程

---

## 1. 背景与问题

Agent 当前有 3 个自动化工具：`automation_read`、`automation_set`、`automation_query`。

**核心问题**：`automation_set` 是 6 合 1 工具（create/update/delete/enable/disable/run_now），`create` action 需要 agent 同时决策：
- schedule type（cron / once / interval / manual）
- cron 表达式或 intervalMs
- trigger mode
- model / thinking level
- … 共 10+ 字段

Agent 面对如此多决策点，很难独立创建出合理的自动化任务。结果是：
- Agent 倾向于让用户手动创建任务，而不是自己管理
- 前端已有的 12 个模板能力无法被 Agent 利用
- 搜索/筛选任务的能力缺失

**目标**：提供两条创建路径（模板快捷创建 + 自由创建）+ 搜索能力 + Routine 层工具，让 Agent 能根据场景自主选择最优方式管理自动化任务。

---

## 2. 设计范围

### 包含
- `automation_list` — 搜索/筛选已有任务
- `automation_template` — 模板化创建（list + create）
- `routine_read` — 查看每日日程
- `routine_trigger` — 手动触发日程条目
- `routine_update` — 修改日程条目
- `routine_regenerate` — 重新生成日程

### 不包含
- 修改 Routine 层生成逻辑（LLM adapter / rule engine）
- 自动化任务的 model / thinking level 配置（保持现状）
- 前端变更（工具纯后端）

---

## 3. Automation 层增强

### 3.1 两条创建路径

Agent 创建自动化任务时，有两种方式可选：

| 路径 | 工具 | 适用场景 |
|------|------|----------|
| **模板快捷创建** | `automation_template { action: "create", templateId: "..." }` | 常见场景（每日 bug 扫描、站会摘要等），只需传模板 ID，可选覆盖名称/prompt/调度 |
| **自由创建** | `automation_set { action: "create", ... }` | 非常规需求，agent 自行决策所有字段（schedule type、cron 表达式、prompt 等） |

两种路径并存，互不替代。`automation_set` 的 `create` action 行为完全不变。

### 3.2 `automation_list`（新增）

替代 `automation_read` 的列表能力，增加搜索和筛选。

**输入**

```ts
{
  query?: string,        // 名称模糊匹配（中文）
  enabled?: boolean,     // 按启用状态筛选
  scheduleType?: string, // cron | once | interval | manual
  hasRecentRun?: boolean,// 最近 7 天内是否有执行记录
  limit?: number         // 返回数量上限，默认 50，最大 200
}
```

**输出**

```ts
{
  ok: true,
  total: number,
  jobs: AutomationJob[]
}
```

**行为**
- 无任何筛选参数时返回所有任务（按 updatedAt 降序）
- `query` 对 `name` 做 `includes()` 模糊匹配（中文全匹配）
- `hasRecentRun` 为 true 时只返回 `lastRunAt` 在 7 天内的任务
- 始终受 `workspaceId` 过滤（同 `automation_read` 逻辑）

### 3.3 `automation_template`（新增）

**子 action：list**

```ts
automation_template { action: "list" }
```

返回所有可用模板。模板分为两类：

**类型 A：通用自动化模板**（12 个，来源前端 `AutomationManagementView.tsx`）

| templateId | name | 默认 cron | 描述 |
|---|---|---|---|
| daily-bug-scan | 每日缺陷扫描 | 0 9 * * * | 扫描最近提交查找 bug |
| weekly-release-notes | 每周版本说明 | 0 9 * * 1 | 基于 PR 起草发布说明 |
| standup-summary | 站会摘要 | 0 9 * * * | 总结昨日 git 活动 |
| nightly-ci-report | 夜间 CI 报告 | 0 22 * * * | 总结 CI 失败和不稳定测试 |
| daily-classic-game | 每日经典游戏 | 0 9 * * * | 创建经典小游戏 |
| skill-progression | 技能进阶图 | 0 9 * * 1 | 基于 PR 建议技能改进 |
| weekly-eng-summary | 每周工程摘要 | 0 9 * * 5 | 汇总本周 PR/发布/故障 |
| perf-regression | 性能回归监测 | 0 9 * * * | 对比基准标记性能回归 |
| dep-sdk-drift | 依赖项和 SDK 漂移 | 0 9 * * 1 | 检测依赖漂移 |
| issue-triage | 问题分类 | 0 9 * * * | 分诊新问题建议优先级 |
| changelog-update | 更新变更日志 | 0 17 * * 5 | 用本周亮点更新变更日志 |
| dep-security-scan | 依赖项扫描 | 0 9 * * 1 | 扫描过时依赖项提出升级方案 |

**类型 B：Routine 活动模板**（9 个，来源 `routine-activities.ts`）

| templateId | name | 默认 schedule | 描述 |
|---|---|---|---|
| routine-data-sync | 数据同步 | once | 同步微信读书数据 |
| routine-reading-progress | 读书进度推进 | once | 推进在读书籍进度 |
| routine-reading-note | 读书笔记 | once | 为在读生成读书笔记 |
| routine-memory-organize | 记忆整理 | once | 整理近期记忆 |
| routine-todo-review | 待办提醒 | once | 检查待办事项 |
| routine-interest-digest | 兴趣资讯 | once | 搜索聚合资讯（当前禁用） |
| routine-work-overview | 工作概览 | once | 生成工作日报（工作日） |
| routine-daily-summary | 每日总结 | once | 汇总日程执行结果 |
| routine-weekly-summary | 每周总结 | once | 生成本周总结（周日） |

**模板输出格式**

```ts
{
  ok: true,
  templates: [
    {
      templateId: string,
      name: string,
      description: string,
      prompt: string,
      schedule: AutomationSchedule,
      category: "automation" | "routine"
    }
  ]
}
```

**子 action：create**

```ts
automation_template {
  action: "create",
  templateId: string,
  name?: string,           // 覆盖模板默认名称
  prompt?: string,         // 覆盖模板默认 prompt
  cronExpr?: string,       // 覆盖默认 cron（仅 template.schedule.type === "cron"）
  runAt?: number,          // 覆盖默认 runAt（仅 template.schedule.type === "once"）
  intervalMs?: number,     // 覆盖默认 interval（仅 template.schedule.type === "interval"）
  enabled?: boolean        // 是否启用，默认 true
}
```

**行为**
- 根据 `templateId` 查找模板定义
- 未找到模板则报错
- `name` / `prompt` / 调度字段按优先级覆盖：显式传参 > 模板默认
- `name` 默认取模板的 `name`
- `prompt` 默认取模板的 `prompt`
- 调度字段默认取模板的 `schedule`
- `enabled` 默认 true
- 创建后自动刷新 runner
- 返回创建结果（同 `automation_set` 的 create 返回格式）

### 3.4 现有工具行为不变

| 工具 | 改动 |
|------|------|
| `automation_read` | 不变，仍用于读取单个任务详情 |
| `automation_set` | 不变，6 个 action 保持现状 |
| `automation_query` | 不变，查询运行记录 |

---

## 4. Routine 层工具

### 4.1 `routine_read`

**输入**

```ts
{
  date?: string    // YYYY-MM-DD，默认今天
}
```

**输出**

```ts
{
  ok: true,
  routine: DailyRoutine | null  // null 表示该日期无日程
}
```

**行为**
- 读取指定日期的日程文件（`~/.lume/routine/schedules/{date}.json`）
- 先调用 `syncRoutineStatus()` 刷新条目状态
- 无日程时返回 `{ ok: true, routine: null }`（不报错）
- 返回的 `DailyRoutine` 包含 entries，每个 entry 有：
  - `activity`、`scheduledAt`、`status`
  - `automationJobId`（底层自动化任务 ID）
  - `result`（执行结果，已完成条目才有）
  - `description`、`customName`、`customPrompt`（如果有）

### 4.2 `routine_trigger`

**输入**

```ts
{
  entryId: string   // 日程条目 ID
}
```

**输出**

```ts
{
  ok: true,
  routine: DailyRoutine
}
```

**行为**
- 找到今日日程中指定 `entryId` 的条目
- 重置条目状态为 `pending`
- 为该条目创建底层 Automation Job（使用预定义 executor 或 customPrompt）
- 刷新 runner 使任务立即执行
- 返回更新后的日程

**错误情况**
- 条目不存在 → 报错
- 无预定义 executor 且无 customPrompt → 报错

### 4.3 `routine_update`

**输入**

```ts
{
  entryId: string,          // 必填
  customPrompt?: string,    // 覆盖执行 prompt（自定义活动）
  customName?: string,      // 覆盖显示名称（自定义活动）
  description?: string,     // 更新描述
  scheduledAt?: number      // 调整执行时间戳
}
```

**输出**

```ts
{
  ok: true,
  routine: DailyRoutine
}
```

**行为**
- 按 `entryId` 找到条目并更新字段
- 仅更新提供的字段，其余保持不变
- `scheduledAt` 变更后同步更新底层 `automationJobId` 对应任务的 schedule
- 写回日程文件

### 4.4 `routine_regenerate`

**输入**

```ts
{
  force?: boolean   // true 时保留已完成条目，false 或不传时完全重新生成
}
```

**输出**

```ts
{
  ok: true,
  routine: DailyRoutine
}
```

**行为**
- 调用 `generateDailyRoutine(date, force)`
- 调用 `scheduleRoutineEntries(routine)` 为所有 pending 条目创建 Automation Job
- 返回生成的日程

---

## 5. 文件变更清单

### 新增文件
| 文件 | 说明 |
|------|------|
| `apps/sidecar/src/services/agent-runtime/tools/cron/automation-list-tools.ts` | `automation_list` 工具 |
| `apps/sidecar/src/services/agent-runtime/tools/cron/automation-template-tools.ts` | `automation_template` 工具（含模板定义） |
| `apps/sidecar/src/services/agent-runtime/tools/routine/create-routine-tools.ts` | `routine_read/trigger/update/regenerate` 工具 |
| `apps/sidecar/src/services/agent-runtime/tools/routine/routine-tools.test.ts` | Routine 工具测试 |

### 修改文件
| 文件 | 改动 |
|------|------|
| `apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts` | 引入新工具组，加入 `routineTools` |
| `packages/shared/src/types/routine.ts` | 可能需要补充 IPC 通道常量（如果新增 channel） |

### 不变
- `create-cron-tools.ts`（保留不动）
- `automation-handlers.ts`
- `routine-handlers.ts`
- 前端任何文件

---

## 6. 工具注册流程

```
createLumeRuntimeTools()
  ├── memoryTools
  ├── cronTools          ← createSdkCronTools() — 不变
  ├── automationListTools   ← 新增 createAutomationListTools()
  ├── automationTemplateTools ← 新增 createAutomationTemplateTools()
  ├── imTools
  ├── readingTools
  ├── uiTools
  ├── officeTools
  └── routineTools       ← 新增 createRoutineTools()
```

新工具均通过 `createSdkJsonResultTool()` 创建，复用现有工具模式。

---

## 7. 实现顺序

1. **automation_list** — 最简单，纯读取 + 过滤，不涉及写入
2. **automation_template** — 引入模板定义 + create 逻辑
3. **routine_read** — 只读，复用 routine-store
4. **routine_trigger** — 复用 routine-executor 的 triggerRoutineEntry
5. **routine_update** — 复用 routine-store 的 updateEntryStatus 扩展
6. **routine_regenerate** — 复用 routine-generator + executor

每个工具完成后跑测试，最后统一注册到 `createLumeRuntimeTools`。

---

## 8. 自审检查

- [x] **Placeholder**：无 TBD/TODO
- [x] **一致性**：模板 ID 与实际前端 ID 对齐；schedule 字段行为与 `automation_set` 一致
- [x] **范围**：纯后端工具，不改前端
- [x] **歧义**：`routine_update` 的 `scheduledAt` 变更会同步底层 automation job — 已在行为中明确
- [x] **命名**：`automation_` 前缀用于 Automation 层，`routine_` 前缀用于 Routine 层
