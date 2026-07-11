# 持久化 Subagent 协作循环设计

| 项 | 值 |
|---|---|
| 日期 | 2026-07-10 |
| 状态 | 已实施，待人工验收 |
| 范围 | SDK、Sidecar、Shared、Web |
| 参考实现 | `openai/openai-agents-js` commit `04807e33347b2b92bdde7685d83d84f1bc144c6d` |
| 取代设计 | `2026-06-29-delegate-independent-subsession-design.md`、`2026-06-30-delegate-stage2-wait-design.md` 中的双工具、后台委派和显式 wait 决策 |

## 1. 背景

Lume 当前的 Subagent 机制同时存在四个问题：

1. `run_in_background` 分支通过 `void executeSubagent()` 脱离父调用链，子会话可能在主会话结束后继续运行。
2. 前端投影会识别带 `subagentRunId` 的事件，但只更新 Agent 工具卡状态并丢弃实际流式内容。
3. 主 Agent 依赖提示词主动调用 `WaitForDelegations`，运行时没有保证最终答复前已收敛全部子任务。
4. 现有 `SubagentRun` 同时承担子代理身份、任务和单次执行三种含义，无法可靠表达任务返工、同类任务复用和主动退休。

OpenAI Agents JS 的 `agent.asTool()` 提供了更可靠的基础语义：嵌套 Agent 是一个普通函数工具调用；同一回合的多个工具可以并行，但每个工具只有在嵌套 Run、流式消费和收尾处理全部完成后才返回。只要当前回合包含工具调用，父 Runner 就不能把同回合的 Assistant 文本当作最终答复。

Lume 在此基础上增加桌面端特有能力：Subagent 拥有可见、可打开、可持久化和可复用的独立子会话；主 Agent 负责验收、继续派工和退休决策。

## 2. 目标

1. 多个不同 Subagent 可以真实并行执行。
2. 每个 Subagent 的文本、工具活动和结果实时展示在对应父会话卡片中。
3. 父 Runner 强制等待当前回合的所有 Subagent Run 进入终态。
4. Subagent 一轮执行完成不等于任务完成；任务必须由主 Agent 明确验收。
5. 同一任务可以由同一 Subagent 多轮继续，同类或相关任务可以复用其上下文。
6. Subagent 完成任务后保持可复用和侧栏可见，直到主 Agent 明确退休。
7. 刷新页面或重启 Sidecar 后可以恢复会话、任务、历史执行和待验收状态。
8. 父会话停止、失败或退出时不得遗留游离的活动 Run。

## 3. 非目标

- 不支持 Subagent 再创建下一层 Subagent；最大深度保持为 1。
- 不长期保留空闲模型连接或常驻 Runtime。
- 不让用户在父控 Subagent 子会话中直接与主 Agent 同时派工；子会话第一阶段为查看模式。
- 不自动用模糊匹配替主 Agent 选择复用对象；运行时只提供可用列表和确定性校验。
- 不引入新依赖。

## 4. 核心决策

### D1：统一为一个 Agent 工具

所有 Subagent 都是侧栏可见、可打开和可复用的独立子会话。删除 `Delegate` 与 `WaitForDelegations` 的新调用入口。

### D2：持久逻辑身份，按需恢复 Runtime

Subagent 的逻辑身份、线程和历史长期保存；物理 Runtime 只在执行 Run 时创建或恢复，完成持久化后立即释放。

### D3：Session、Task、Run 三层建模

- Session 表示可复用协作成员。
- Task 表示由主 Agent 管理和验收的持续目标。
- Run 表示 Task 的一次具体执行尝试。

### D4：不同 Session 并行，同一 Session 串行

不同 Subagent 可以并行；同一 Subagent 共享线程上下文，其 Run 必须 FIFO 串行，避免消息顺序和持久化竞态。

### D5：等待由 Runner 保证

不再依赖模型输出“等待”文案或主动调用 wait 工具。Agent 工具 Promise 只在对应 Run 完整收尾后返回；父 Runner 在当前回合全部 Agent 工具完成前不能继续或结束。

### D6：TaskReport 是提交，不是验收

Subagent 可以报告本轮已提交、失败或阻塞，但不能把 Task 标记为 accepted。只有主 Agent 可以验收、延后或取消。

### D7：子线程是事件唯一事实源

完整 RuntimeEvent 只落在 child thread。父线程保存 Run Link，前端通过 Link 订阅 child thread + runId，不复制或改写子代理事件。

### D8：退休不删除历史

退休只会把 Subagent 从主 Agent 的可复用列表中移除；线程和历史仍保留在侧栏并可打开。

## 5. 领域模型

### 5.1 SubagentSession

```ts
interface SubagentSession {
  subagentId: string
  threadId: string
  parentThreadId: string
  agentType: string
  modelRef?: string
  title: string
  status: "idle" | "busy" | "retired"
  currentTaskId?: string
  currentRunId?: string
  lastTaskSummary?: string
  lastResultSummary?: string
  createdAt: number
  lastUsedAt: number
  retiredAt?: number
}
```

Session 的 `status` 只表达能否接受新 Run。任务是否等待验收由 Task 状态表达，避免把成员状态和工作状态混为一谈。

### 5.2 SubagentTask

```ts
interface SubagentTask {
  taskId: string
  subagentId: string
  parentThreadId: string
  objective: string
  acceptanceCriteria: string[]
  constraints?: string[]
  expectedArtifacts?: string[]
  status:
    | "open"
    | "running"
    | "awaiting_review"
    | "accepted"
    | "deferred"
    | "cancelled"
  attemptCount: number
  createdAt: number
  updatedAt: number
  resolvedAt?: number
}
```

同一交付目标未达到时继续原 Task；新的交付目标即使复用同一 Subagent，也创建新 Task。

### 5.3 SubagentTaskFeedback

```ts
interface SubagentTaskFeedback {
  taskId: string
  attempt: number
  instruction: string
  rejectedReasons?: string[]
  requestedChanges?: string[]
  createdAt: number
}
```

原始目标和验收标准保持不变，主 Agent 的每轮反馈独立追加，防止多轮提示覆盖初始任务。

### 5.4 SubagentRun

```ts
interface SubagentRun {
  runId: string
  taskId: string
  subagentId: string
  childThreadId: string
  parentThreadId: string
  parentRunId: string
  parentToolUseId: string
  attempt: number
  instruction: string
  status:
    | "queued"
    | "running"
    | "completed"
    | "errored"
    | "cancelled"
    | "timed_out"
  report?: SubagentTaskReport
  error?: string
  createdAt: number
  startedAt?: number
  endedAt?: number
}
```

Run 必须进入终态才能解除父 Run 的执行屏障。Run 终态不直接改变 Task 为 accepted。

### 5.5 SubagentTaskReport

```ts
interface SubagentTaskReport {
  status: "submitted" | "failed" | "blocked"
  summary: string
  completedWork?: string[]
  remainingWork?: string[]
  artifacts?: Array<{
    path: string
    description?: string
  }>
  verification?: Array<{
    command?: string
    result: string
    passed: boolean
  }>
  blockers?: string[]
}
```

## 6. 工具协议

### 6.1 Agent

```ts
Agent({
  prompt: string,
  description: string,
  subagent_type?: string,
  subagent_id?: string,
  task_id?: string,
  acceptance_criteria?: string[],
  expected_artifacts?: string[]
})
```

调用规则：

| 输入 | 行为 |
|---|---|
| 无 `subagent_id`、无 `task_id` | 创建 Session、Task 和 Run |
| 有 `subagent_id`、无 `task_id` | 在已有 Session 上创建相关新 Task 和 Run |
| 有 `task_id` | 在 Task 当前绑定的 Session 上创建下一轮 Run |
| 有 `task_id` 且 `subagent_id` 与当前不同 | 记录改派，并在新 Session 上继续同一 Task |

工具调用始终等待本轮 Run 完成。`run_in_background` 不再影响生命周期；兼容解析期可以暂时接受并忽略该字段，但新 schema 和提示词不再暴露它。

返回结构：

```ts
interface AgentToolResult {
  subagentId: string
  childThreadId: string
  taskId: string
  runId: string
  attempt: number
  report: SubagentTaskReport
}
```

### 6.2 FinishAgentTask

```ts
FinishAgentTask({
  task_id: string,
  resolution: "accepted" | "deferred" | "cancelled",
  reason: string
})
```

- accepted：主 Agent 明确验收通过。
- deferred：当前父回合不再继续，但以后可以恢复。
- cancelled：明确放弃任务。

### 6.3 RetireSubagent

```ts
RetireSubagent({
  subagent_id: string,
  reason: string
})
```

只允许退休 idle Session。busy Session 必须先等待或取消当前 Run。退休后线程仍可打开，但不再注入主 Agent 的可复用列表。

## 7. 协作任务循环

```text
主 Agent 创建或继续 Task
    ↓
Coordinator 创建 SubagentRun
    ↓
按需恢复 child thread Runtime
    ↓
Subagent 执行并实时写入 child thread 事件
    ↓
Subagent 调用 TaskReport 提交本轮报告
    ↓
Run 完成、Runtime 收尾并释放
    ↓
Task 进入 awaiting_review，Session 回到 idle
    ↓
主 Agent 决策
    ├─ FinishAgentTask(accepted)
    ├─ Agent(task_id, feedback) 继续同一任务
    ├─ Agent(subagent_id) 创建下一阶段任务
    ├─ Agent(task_id, other_subagent_id) 改派
    ├─ FinishAgentTask(deferred|cancelled)
    └─ RetireSubagent
```

## 8. 调度与收敛

### 8.1 SubagentCoordinator

新增独立 Coordinator，负责：

- 创建和恢复 Session；
- 创建 Task、反馈和 Run；
- 按 Session 串行化 Run；
- 控制全局 Subagent 并发；
- 维护父 Run 的活动子 Run 集合；
- 级联取消；
- 在 Run 收尾后更新 Store 和状态事件。

`runtime-core/run.ts` 只组装工具，不再直接实现完整的 Session/Task/Run 生命周期。

### 8.2 并发规则

- 同一模型回合产生的多个 Agent tool call 由现有工具执行器并发启动。
- Coordinator 允许不同 `subagentId` 的 Run 并行。
- 同一 `subagentId` 的 Run 按 tool-call 顺序 FIFO。
- 结果保持原 tool-call 顺序返回给模型。
- 默认最多同时运行 4 个 Subagent，并允许后续配置；该限制不改变普通工具并发。

### 8.3 两级屏障

Run 屏障：

```text
当前 parentRunId 存在 queued/running SubagentRun
→ 禁止父 run.completed
```

Task 验收屏障：

```text
当前父回合产生 awaiting_review Task
→ 主 Agent 必须 continue / accept / defer / cancel / reassign
```

如果主 Agent 尝试直接结束，Runner 追加内部反馈并重新运行模型，而不是把占位文本输出为最终答复。

## 9. Runtime 生命周期与取消

```text
idle Session
→ 收到 Run
→ 从 child thread transcript 恢复 Runtime
→ 执行并持久化
→ 等待流消费、回调、会话写入和清理完成
→ dispose Runtime
→ Session 回到 idle
```

- 父 AbortSignal 与子 Run AbortSignal 组合，父停止时级联取消。
- 父 Run 失败时，已完成的报告保留，活动和排队 Run 取消。
- 单个子 Run 失败不取消其他并行 Session。
- 超时 Run 标记 timed_out，Task 进入 awaiting_review，由主 Agent 决定重试、改派或取消。
- Sidecar 重启前仍在运行的 Run 标记 errored，Task 保留为 awaiting_review。

## 10. 事件协议

### 10.1 子线程作为唯一事实源

子会话正常保存普通 RuntimeEvent：

```ts
RuntimeEvent {
  threadId: childThreadId
  runId: subagentRunId
  sequence: number
  // assistant.delta、tool.started、tool.completed 等
}
```

父会话仅保存关联：

```ts
interface SubagentRunLink {
  parentThreadId: string
  parentRunId: string
  parentToolUseId: string
  subagentId: string
  childThreadId: string
  taskId: string
  runId: string
}
```

每个 Run 内 `sequence` 单调递增，避免并行事件仅按时间戳排序时乱序。

### 10.2 生命周期事件

```text
subagent.session.created
subagent.session.status_changed
subagent.session.retired
subagent.task.created
subagent.task.status_changed
subagent.task.resolved
subagent.run.queued
subagent.run.started
subagent.run.completed
subagent.run.failed
subagent.run.cancelled
```

文本和工具活动继续复用现有 RuntimeEvent，不建立第二套子代理内容协议。

## 11. 前端体验

### 11.1 父会话内联卡片

每次 Agent tool call 对应一个 Run 卡片，显示：

- Subagent 名称和类型；
- Task 标题和 attempt；
- queued、running、awaiting review、accepted、failed 等状态；
- 最近一条可展示文本或工具活动；
- 工具数量和耗时；
- 展开过程和打开子会话入口。

展开后直接读取 `childThreadId + runId` 的事件，展示本轮文本、工具、产物、验证结果、remainingWork 和错误。隐藏推理不向父卡片公开。

同一 Task 的多轮 Run 通过 `taskId` 关联，任务详情中展示完整迭代历史；父时间线仍保留每次真实工具调用的位置。

### 11.2 侧栏

```text
主任务
├─ developer-02    等待验收
├─ explorer-01     空闲
└─ reviewer-01     运行中
```

- 运行中：Session 有 active Run。
- 等待验收：最新 Task 为 awaiting_review。
- 空闲：没有开放 Task，可复用。
- 已退休：不再参与调度，线程仍可打开。

标题保持稳定身份，例如 `developer-02 · 事件链路修复`，不再用每次最终输出覆盖标题。

### 11.3 子会话

打开后显示完整连续记录：主 Agent 委派、Subagent 执行、主 Agent 反馈、后续 Run 和最终验收。第一阶段为查看模式，避免用户直接派工与父 Agent 派工产生双重控制。

## 12. 提示词与 TaskReport 协议

### 12.1 主 Agent 提示词

- Subagent Run 完成不代表 Task 已验收。
- 结果未满足目标时，使用相同 task_id 提供具体反馈。
- 相互独立任务应在同一回复中发出多个 Agent 调用。
- 不输出“我会等待”等占位文字；Agent 工具本身负责等待。
- 未处理 awaiting_review Task 前不得生成最终答复。
- 同一目标未完成时不要创建重复 Task。
- 只有上下文相关时才复用已有 Subagent。

每轮向主 Agent 注入精简的可复用列表：subagentId、类型、状态、最近任务摘要、最近结果摘要和开放 Task，不注入完整子会话历史。

### 12.2 Subagent 提示词

每轮包含固定 Task 契约、attempt、上轮报告和主 Agent 新反馈。Subagent 只执行当前 Task，不能改变验收目标，也不能创建下一层 Subagent。

Subagent 完成、失败或阻塞时必须调用绑定当前 IDs 的 TaskReport。现有计划 TaskRun 的 `TaskReport(completed|failed|blocked)` 语义保持不变；Subagent 使用同一结构化报告模式，但由 Coordinator 绑定 IDs，并将成功状态解释为 submitted，而不是 accepted。

Run 结束但没有 TaskReport 时，本轮标记 errored，Task 进入 awaiting_review。

## 13. 防止无限循环

- 每个 Subagent Run 保留独立最大回合数、超时和 token 预算。
- 同一 Task 在单次父 Run 中最多连续返工 3 次。
- 达到 3 次后，主 Agent 必须改派、请求用户决策、defer，或说明继续的具体新策略。
- 跨用户回合可以继续原 Task。
- 连续两轮报告的产物、验证结果和摘要无实质变化时标记 stalled，要求改变指令或改派。
- 最大 Subagent 深度固定为 1。
- 父 Run 取消后禁止自动重启子 Run。

## 14. 数据迁移与兼容

旧 `SubagentRunRecord` 在读取时迁移：

```text
旧 childThreadId → SubagentSession
旧 Run           → SubagentTask + SubagentRun(attempt=1)
```

- completed 旧 Run 迁移为 accepted Task。
- failed、aborted、timed_out、canceled 保留原 Run 状态。
- 进程重启时仍 active 的旧 Run 标记 errored，Task 为 awaiting_review。
- 沿用原 childThreadId，侧栏和历史链接不失效。
- Store 升级使用版本号和原子写入；迁移失败不覆盖旧文件。
- 历史中的 Delegate/WaitForDelegations 内容继续渲染，但新 Runtime 不再暴露这些工具。

## 15. 旧机制清理

完成迁移后删除：

- SDK AgentTool 的 detached background 分支；
- `run_in_background` 和 `isolation: remote` 后台语义；
- Sidecar Delegate 与 WaitForDelegations 工具；
- registry completion semaphore 和 wait 方法；
- 异步 Delegate + 显式 wait 的提示词；
- 把子代理 SDKMessage 改写到父线程的转发路径；
- 前端遇到 subagent owner 后直接丢弃内容的逻辑；
- 仅表达单次完成的旧 SUBAGENT_COMPLETED 状态通道。

保留并复用：

- 独立 child thread 和 parentThreadId；
- Runtime transcript、run-state 和 trace；
- `TaskReport` 的结构化报告模式；
- 现有工具执行并发框架；
- 交互请求向父会话展示的现有能力；
- 原子 Store 写入和进程重启陈旧 Run 处理模式。

## 16. 实施阶段

1. 数据模型与 Store：加入 Session/Task/Run、反馈、Link 和旧数据迁移，不改变执行行为。
2. Coordinator 与 SDK 等待：实现并发/FIFO/取消/收尾等待，删除 detached background。
3. 任务循环：接入 Subagent TaskReport、FinishAgentTask、RetireSubagent 和两级屏障。
4. 事件与前端：child thread 事实源、父 Run Link、实时卡片、多轮历史和侧栏状态。
5. 旧机制删除：移除 Delegate、WaitForDelegations、completion semaphore、旧提示词、旧 IPC 和无用前端状态。

每个阶段保持小提交、可审查和可回退，不与工作区其他改动混合。

## 17. 测试策略

### 17.1 SDK/Runner

- 同回合两个 Agent 工具实际重叠执行。
- 父 Runner 等待全部 Agent 完成。
- 工具结果保持原 tool-call 顺序。
- 流结束后仍等待持久化、回调和清理。
- 父 AbortSignal 级联到活动子 Run。
- 当前回合有工具调用时，同回合 Assistant 文本不能成为最终答复。

### 17.2 Coordinator

- 创建 Session、Task 和首个 Run。
- 相同 taskId 生成下一轮 Run。
- 相同 subagentId 创建相关新 Task。
- 不同 Session 并行，同一 Session FIFO。
- 单 Run 失败不取消其他并行 Session。
- queued/running Run 阻止父完成。
- awaiting_review Task 阻止父直接完成。
- 缺失 TaskReport 时 Run 失败。
- accepted/deferred/cancelled/retired 状态转换合法。
- 重启恢复 Session、Task 和历史 Run。
- retired Session 不再出现在可复用列表。

### 17.3 前端

- 子代理文本不混入主 Agent 文本。
- 父卡片实时读取对应 child thread Run。
- 并行卡片不串流。
- 刷新前后投影一致。
- 同 Task 多轮 Run 正确归组。
- 打开侧栏子会话可见完整连续历史。
- running、awaiting review、idle、retired 状态正确。

### 17.4 端到端

1. 主 Agent 同轮启动两个 Subagent。
2. 两个 Subagent 并行并实时展示。
3. 一个先完成时父 Run 仍保持活动。
4. 两个都完成后主 Agent 收到结构化报告。
5. 主 Agent 对一个 Task 提出具体反馈并继续相同 taskId。
6. 同一 Subagent 恢复上下文完成第二轮。
7. 主 Agent 验收两个 Task，两个 Session 回到 idle。
8. 后续相关任务复用其中一个 Session。
9. 主 Agent 退休不再需要的 Session，历史仍可打开。

## 18. 验收标准

1. 多个不同 Subagent 能真实并行。
2. 所有可公开执行内容都展示在正确父卡片和子会话中。
3. 主 Agent 无法在子 Run 尚未结束时完成对话。
4. Run 完成与 Task 验收严格分离。
5. 同一 Task 可以由同一 Subagent 多轮继续。
6. 同类或相关任务可以复用已有 Subagent。
7. 完成后的 Subagent 保持 idle、侧栏可见且可打开。
8. 主 Agent 明确决定验收、延后、取消和退休。
9. 父停止或失败后不存在游离活动 Run。
10. 刷新或 Sidecar 重启后协作状态可恢复。

## 19. 风险与约束

- 最大风险是现有 TaskRun 与 SubagentTask 名称接近但验收语义不同。实施时只复用结构化报告模式，不静默改变现有计划任务的完成语义。
- 父会话和子会话同时持久化完整事件会造成重复和漂移，因此父侧必须只存 Link。
- 同一 Session 并发会破坏 transcript 顺序，因此 Coordinator 的 FIFO 是硬约束。
- 兼容期接受旧 run_in_background 输入不得重新引入 detached 执行。
- 旧设计文档保留作为历史记录，但本设计在冲突处优先。
