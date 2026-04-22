# 事件驱动自动化系统 — 设计文档

> 日期：2026-04-21
> 状态：已确认
> 分支：feat/new-ui

## 1. 背景与目标

Lume 现有自动化系统仅支持 cron 定时任务，缺乏事件驱动能力和 AI 主动发现自动化机会的能力。本次重设计旨在构建一个全新的事件驱动自动化系统，核心特性：

- **AI 主动发现自动化机会**：通过观察用户重复行为模式和对话中表达的痛点，自动生成自动化建议
- **安全的交互模式**：AI 建议 → 用户确认 → 执行，用户始终掌控
- **双触发模式**：支持时间触发（cron）和事件触发（event）
- **Agent + 外部工具**：自动化任务可调用 Agent 工具和外部服务

## 2. 整体架构

四层架构，数据自上而下流动：

```
信号源层（Signal Sources）
  Agent 对话 · 用户操作 · 系统事件 · 外部服务
        │
        ▼
事件总线（Event Bus）
  统一事件流 · 分类路由 · SQLite 持久化
        │
        ▼
AI 分析引擎（Pattern Analyzer）
  重复检测 · 痛点识别 · 建议生成
        │
        ▼
自动化引擎（Automation Engine）
  建议展示 · 用户确认 · 任务调度 · 执行追踪
```

### 数据流

**发现流程：**
用户操作 → 信号源采集 → 写入事件总线 → AI 分析引擎检测模式 → 生成自动化建议 → 展示给用户 → 用户确认 → 创建自动化任务

**执行流程：**
触发条件满足 → 调度引擎启动 → Agent 执行任务 → 可调用外部工具 → 记录执行结果

### 与现有系统的关系

复用：JSON-RPC 通信模式、IPC 通道命名约定、Agent 工具系统（defineTool）、前端 Jotai 状态管理、监听器发布-订阅模式。

替换：automation-manager.ts、automation-runner-service.ts、cron-tools.ts（SDK）、create-cron-tools.ts（PI-Agent）。

## 3. 事件总线（Event Bus）

### 3.1 核心接口

```typescript
interface AutomationEvent {
  id: string;           // 事件唯一 ID
  type: EventType;      // 事件类型
  source: EventSource;  // 信号来源
  workspaceId: string;  // 所属工作区
  timestamp: number;    // 时间戳
  payload: Record<string, unknown>;  // 事件数据
  fingerprint: string;  // 去重指纹
}
```

### 3.2 事件来源

```typescript
enum EventSource {
  agent_chat,         // Agent 对话消息
  tool_call,          // Agent 工具调用
  user_action,        // 用户界面操作
  file_change,        // 文件系统变更
  external_webhook,   // 外部服务回调
  system,             // 系统内部事件
}
```

### 3.3 事件类型

| 来源 | 事件类型 | 说明 |
|------|----------|------|
| agent_chat | message.sent | 用户发送消息 |
| agent_chat | tool.invoked | Agent 调用工具 |
| tool_call | bash.executed | 执行 Bash 命令 |
| tool_call | file.written | 写入文件 |
| user_action | workspace.switched | 切换工作区 |
| user_action | thread.created | 创建新会话 |
| file_change | file.modified | 文件内容变更 |
| external_webhook | github.pr_opened | 外部服务事件 |

### 3.4 存储策略

- SQLite 持久化，按 workspace 分区
- 30 天滚动窗口，超期自动清理
- 分析引擎查询时直接读数据库
- 不做事件回放/重放、分布式事件流、精确一次投递

### 3.5 接入方式

各模块通过 `EventBus` 单例接入，提供 `emit()` 和 `subscribe()` 两个核心方法。遵循现有 `AgentRuntimeStatusManager` 的监听器模式。

## 4. AI 分析引擎（Pattern Analyzer）

### 4.1 频率检测器（Frequency Detector）

纯结构化规则，不依赖 LLM，轻量快速。

- 滑动窗口 7 天内，统计相似事件序列出现次数
- 相似度判定：同 source + 同 type + payload 关键字段匹配
- 触发阈值：同一模式出现 ≥ 3 次，且跨越 ≥ 2 个不同日期
- 输出：`{ pattern, count, firstSeen, lastSeen, samplePayloads }`

### 4.2 语义分析器（Semantic Analyzer）

利用 LLM 理解对话上下文，识别用户痛点。

- 触发时机：Agent 对话结束时，对最近对话做一次分析
- 分析内容：用户是否表达重复性工作不满、是否多次请求类似任务、是否存在可自动化的手动操作
- 输出：`{ insight, suggestedAutomation, confidence, evidence }`
- confidence < 0.6 的建议直接丢弃

### 4.3 建议生成器（Suggestion Generator）

合并两个检测器结果，去重后生成最终建议。

```typescript
interface AutomationSuggestion {
  id: string;
  workspaceId: string;
  title: string;            // "每天早上总结 GitHub PR"
  description: string;      // 面向用户的解释
  triggerType: 'cron' | 'event';
  triggerConfig: TriggerConfig;
  actionPrompt: string;     // Agent 执行的 prompt
  evidence: string[];       // 为什么建议这个自动化
  source: 'frequency' | 'semantic' | 'both';
  confidence: number;       // 0-1
  status: 'pending' | 'accepted' | 'dismissed';
  createdAt: number;
}
```

### 4.4 节流与降噪

- 频率检测器 5 分钟轮询一次（非实时）
- 语义分析器每次对话结束最多分析一次
- 同一工作区每天最多生成 3 条建议
- 用户 dismiss 的模式 14 天内不再建议
- confidence < 0.6 自动丢弃

不做：实时分析、跨工作区检测、用户画像/习惯学习、ML 模型训练。

## 5. 自动化引擎（Automation Engine）

### 5.1 任务生命周期

```
建议 → 用户确认 → 已创建 → 启用 → 运行中 → 暂停/完成 → 已停止
```

用户可随时 dismiss 建议、暂停任务、重新启用任务。

### 5.2 触发类型

**时间触发（Cron）：**
- 标准 5 字段 cron 表达式
- 一次性定时执行
- 防并发执行（同任务不重叠）

**事件触发（Event）：**
- 匹配事件总线上的特定事件
- 支持条件过滤（如：特定文件变更）
- 支持 debounce（短时间内同类事件合并）

### 5.3 执行模型

1. 触发器匹配（cron 到时 / 事件命中）
2. 检查任务是否启用 + 未在运行中
3. 创建 Agent 线程（或复用已有线程）
4. 发送 actionPrompt 给 Agent
5. Agent 执行，可调用已授权的工具
6. 记录执行结果到 AutomationRun
7. 如果绑定了通知线程，推送结果摘要

```typescript
interface AutomationRun {
  id: string;
  automationId: string;
  status: 'running' | 'success' | 'failed';
  triggeredBy: 'cron' | 'event' | 'manual';
  startedAt: number;
  completedAt: number | null;
  result: string | null;
  error: string | null;
}
```

### 5.4 权限与安全

- 自动化任务的权限 ≤ 用户手动操作权限
- 建议确认时，同时确认该任务可以使用的工具列表
- 敏感操作（删除文件、发送消息到外部）需用户在确认时额外勾选授权
- 失败 3 次连续的任务自动暂停，等待用户检查
- 每次执行结果都记录，用户可随时审计

### 5.5 IPC 通道

**请求通道（前端 → 后端）：**
- `automation:list-jobs` — 列出自动化任务
- `automation:create-job` — 创建任务
- `automation:update-job` — 更新任务
- `automation:delete-job` — 删除任务
- `automation:list-runs` — 查看执行记录
- `automation:run-now` — 立即执行
- `automation:list-suggestions` — 列出待处理建议
- `automation:accept-suggestion` — 接受建议
- `automation:dismiss-suggestion` — 忽略建议

**通知通道（后端 → 前端）：**
- `automation:suggestion-new` — 新建议产生
- `automation:run-completed` — 执行完成
- `automation:job-paused` — 任务被自动暂停

## 6. 前端界面

### 6.1 建议卡片（对话内）

当 AI 分析引擎生成建议时，在当前对话线程中以卡片形式展示：
- 显示建议标题和描述
- 展示证据（如"连续 3 天早上请求 PR 总结"）
- 显示建议的触发方式
- 三个操作按钮：确认创建 / 调整配置 / 忽略

### 6.2 自动化管理面板

左侧边栏新增"自动化"入口，进入管理面板：
- 三个筛选 tab：全部、运行中、建议
- 任务列表：显示名称、触发方式、上次运行时间、状态
- 建议条目：高亮展示，带快捷接受/忽略按钮
- 支持手动创建新自动化任务

### 6.3 前端状态管理

```typescript
// Jotai Atoms
automationsAtom: AutomationJob[]                    // 所有自动化任务
suggestionsAtom: AutomationSuggestion[]             // 待处理建议
automationRunsAtom: Record<string, AutomationRun[]> // 执行记录
```

通过 `useAutomationListeners` hook 监听后端通知，实时更新 atoms。

### 6.4 RPC Handlers

`apps/sidecar/src/rpc/automation-handlers.ts` 需重写，注册所有新 IPC 通道的处理函数，包括建议管理和通知推送。

## 7. 模块结构与文件组织

### 7.1 后端（Sidecar）

```
apps/sidecar/src/services/automation/
├── index.ts                    // 服务入口，组装各子模块
├── event-bus/
│   ├── event-bus.ts            // 核心事件总线
│   ├── event-types.ts          // 事件类型定义
│   ├── event-store.ts          // SQLite 持久化
│   └── event-emitters/
│       ├── agent-chat-emitter.ts
│       ├── tool-call-emitter.ts
│       └── user-action-emitter.ts
├── analyzer/
│   ├── pattern-analyzer.ts     // 分析引擎入口
│   ├── frequency-detector.ts   // 频率检测器
│   ├── semantic-analyzer.ts    // 语义分析器（LLM）
│   ├── suggestion-generator.ts // 建议生成器
│   └── prompts/
│       └── analyze-patterns.md // LLM 分析 prompt 模板
└── engine/
    ├── automation-engine.ts    // 自动化引擎主逻辑
    ├── cron-scheduler.ts       // Cron 调度器
    ├── event-trigger.ts        // 事件触发器
    ├── execution-runner.ts     // 任务执行器
    └── run-store.ts            // 执行记录存储
```

### 7.2 共享类型

```
packages/shared/src/types/automation.ts  // 替换现有文件
```

包含：AutomationEvent、EventSource、EventType、AutomationSuggestion、AutomationJob、AutomationRun、TriggerConfig、AUTOMATION_IPC_CHANNELS。

### 7.3 前端

```
apps/web/src/
├── atoms/
│   └── automation-atoms.ts
├── components/automation/
│   ├── AutomationPanel.tsx
│   ├── AutomationJobList.tsx
│   ├── AutomationJobCard.tsx
│   ├── SuggestionCard.tsx
│   ├── SuggestionPanelItem.tsx
│   └── JobCreateDialog.tsx
└── hooks/
    └── useAutomationListeners.ts
```

### 7.4 Agent 工具

`packages/sdk/src/tools/automation-tools.ts`（替换 cron-tools.ts）：
- `automation_list` — 列出自动化任务
- `automation_create` — 创建自动化任务（cron | event）
- `automation_update` — 更新任务
- `automation_delete` — 删除任务
- `automation_run_now` — 立即执行
- `automation_list_runs` — 查看执行记录
- `automation_list_suggestions` — 查看待处理建议

### 7.5 删除清单

- `apps/sidecar/src/services/automation/automation-manager.ts`
- `apps/sidecar/src/services/automation/automation-runner-service.ts`
- `packages/sdk/src/tools/cron-tools.ts`
- `apps/sidecar/src/services/pi-agent/tools/cron/`
- 旧 `packages/shared/src/types/automation.ts`（替换为新类型）
- `apps/sidecar/src/rpc/automation-handlers.ts`（需重写以适配新 IPC 通道）
