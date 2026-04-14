# Subagent Full Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主线程能够流式展示 subagent 的完整工作流程，包括启动、工具调用、工具结果、thinking、正文输出、最终结果，而不是仅显示 task 生命周期卡片和完成后摘要。

**Architecture:** 保持当前 `Tauri desktop + Next.js web + Bun sidecar + shared packages` 分层，不引入第二套 subagent 渲染协议。复用现有 `SDKMessage` 流、`TaskContainerCard`、`ToolActivity`、`StreamContentBlock` 体系，只补足 subagent 事件透传、聚合和渲染。

**Tech Stack:** TypeScript strict、Bun、`@lume/agent-sdk`、Lume sidecar runtime-core、现有 Agent streaming/rendering 管线。

---

## 背景

当前系统已经接入 subagent 最重要的三个生命周期事件：

1. `task_started`
2. `task_progress`
3. `task_notification`

这些事件已经能够在主线程 UI 中以 task 卡片形式实时展示，因此用户可以看到：

1. subagent 被创建
2. subagent 正在执行
3. subagent 完成或失败

但当前仍有两个核心缺口：

1. subagent 的 assistant 正文、thinking、工具调用细节没有完整流式透传到主线程
2. 主线程最终看到的 subagent 输出正文主要来自完成后的 announce 摘要，而不是运行中的实时内容

因此，当前的 subagent 可视化是“状态流式”，不是“完整流程流式”。

---

## 目标

本实现要达到以下效果：

1. subagent 运行中，主线程 task 卡片内可实时看到工具调用过程
2. subagent 运行中，主线程 task 卡片内可实时看到正文输出
3. subagent 运行中，主线程 task 卡片内可实时看到 thinking 内容
4. subagent 完成后，task 卡片保留最终输出
5. 已有 announce 机制保留，用于完成后的稳定摘要和回放

---

## 非目标

本方案暂不做以下事情：

1. 不把 subagent 正文直接并入主 assistant 主消息正文
2. 不改成“每个 subagent 单独一条主线程 message”的消息结构
3. 不重写 SDK QueryEngine
4. 不引入新的独立 websocket / side-channel
5. 不改变当前 task 卡片作为 subagent 主入口的 UI 结构

---

## 现状结论

### 已有能力

1. SDK `AgentTool` 已经会在 subagent 运行期间发 `task_started / task_progress / task_notification`
2. sidecar 已经会把 SDKMessage 流式转发到 web
3. web 已经能把任务类 system 事件解析成 `ToolActivity`
4. web 已经能用 `TaskContainerCard` 渲染 subagent/task 活动
5. 完成后 announce service 会追加一条稳定摘要消息

### 缺失能力

1. subagent 内部 `assistant` / `stream_event` / `tool_result` 未透传到父线程
2. web 没有按 `subagent_run_id` 聚合“子流”的状态存储
3. `TaskContainerCard` 当前没有正文 / thinking / 工具结果的完整流式区块

---

## 总体方案

在进入具体方案前，先固定四条实现前提，避免后续边做边返工：

### 实现前提 A：`subagent_run_id` 全链路唯一且统一

当前方案里，subagent 的归属键必须只有一套来源。

要求：

1. `subagent_run_id` 由 sidecar wrapper 生成
2. SDK `AgentTool` 必须复用这一个 `subagent_run_id`，不能在内部再生成第二个 run id
3. registry、streaming event、announce、web 聚合统一使用同一个 `subagent_run_id`

否则会出现：

1. task 卡绑定的是一个 run id
2. announce / registry 用的是另一个 run id
3. 多 subagent 并发时发生串流或无法正确回放

### 实现前提 B：subagent assistant 事件不能参与主 assistant 最终投影

sidecar 当前会基于 turn 内持久化的 `SDKMessage` 投影最终 assistant message。

要求：

1. 带 `subagent_run_id` 的 `assistant` / reasoning 事件不能并入主 assistant `content`
2. `projectAssistantMessageFromSdkMessages()`、`extractAssistantTextFromSdkMessages()`、`extractAssistantReasoningFromSdkMessages()` 必须排除 subagent assistant 事件
3. web 侧也不能把 subagent 正文混入主 assistant 的 streaming state

否则会导致主线程正文被 subagent 正文污染。

### 实现前提 C：transport 仍挂在主线程，subagent 只做 ownership 划分

本轮不把 subagent 改成真正独立的 live transport channel。

要求：

1. 透传事件仍通过父线程原有 stream channel 上送
2. `subagent_run_id` 负责区分子流归属
3. `parent_tool_use_id` 负责挂到对应 task card
4. `childThreadId` 仅作为跳转/回放元数据，不改变当前主线程订阅结构
5. 不因为 subagent 透传而切换主线程 `threadId/sessionId` 语义

### 实现前提 D：先采用“保留原始透传事件”的回放策略

为了先把正确性打通，本轮优先保留足够的原始 subagent 透传事件，而不是先设计压缩后的 snapshot 协议。

要求：

1. persisted sdkMessages 中保留用于重建 subagent text / thinking / tool activity 的最小必要事件
2. 先保证刷新后能重建，再考虑后续压缩
3. announce 继续承担稳定摘要职责，但不替代完整子流回放

总体方案分成四层：

1. SDK 层
   在 `AgentTool` 内部遍历 subagent `engine.submitMessage(...)` 时，把关键事件继续透传给父线程。
2. 共享事件层
   尽量复用现有 `SDKMessage`，通过附加 `subagent_run_id`、`parent_tool_use_id` 等字段标识归属，不单独造新协议。
3. Web 状态层
   在现有 streaming state 之外，增加 “按 `subagent_run_id` 聚合的子流状态”。
4. UI 层
   继续以 `TaskContainerCard` 为主体，在卡片内部渲染 subagent 的实时正文、thinking、工具卡和最终输出。

这样做的好处：

1. 不破坏现有主线程消息列表稳定性
2. 不影响主 assistant 的 `streaming -> final` 提交逻辑
3. 可以渐进落地，先展示文本流，再补 thinking 和工具细节

---

## 事件设计

### 方案原则

优先复用已有 `SDKMessage` 类型，不为 subagent 单独发明第二套 message schema。

### 需要透传的事件

subagent 内部运行时，向父线程继续透传：

1. `stream_event`
2. `assistant`
3. `tool_result`
4. `system.task_started`
5. `system.task_progress`
6. `system.task_notification`

### 需要补充的归属字段

每条透传事件至少需要带：

1. `subagent_run_id`
2. `parent_tool_use_id`
3. 父线程 transport 所需的 `session_id`
4. 如有需要，再附加 `childThreadId` 作为跳转/回放元数据

推荐做法：

1. 对现有 `SDKMessage` 做兼容扩展
2. 所有 subagent 透传事件都打上统一的 `subagent_run_id`
3. `parent_tool_use_id` 继续用于和父线程工具树对齐
4. `session_id` 保持父线程语义，不把 subagent 透传事件伪装成独立主线程流

---

## 数据流设计

### 当前数据流

1. 主线程 assistant 调用 `Agent` 工具
2. sidecar wrapper 先创建 run registry 记录
3. SDK `AgentTool` 启动 subagent
4. subagent 内部自己消费 `engine.submitMessage(...)`
5. 仅把 task 生命周期相关的 system 事件发给父线程
6. 最终由 announce service 追加摘要消息

### 目标数据流

1. 主线程 assistant 调用 `Agent` 工具
2. sidecar wrapper 生成唯一 `subagent_run_id`，并传给 SDK `AgentTool`
3. subagent 内部遍历 `engine.submitMessage(...)`
4. 对每个关键事件打上统一的 `subagent_run_id`
5. 通过 `context.emitEvent(...)` 透传到父线程流
6. sidecar 在持久化与最终投影阶段过滤 subagent assistant，避免污染主 assistant message
7. sidecar 原样转发事件到 web
8. web 以 `subagent_run_id` 聚合成一条“子流”
9. `TaskContainerCard` 内部渲染该子流的 thinking / text / tools / result

### inline / background 路径约束

本轮实现统一覆盖两类 subagent 运行路径，但归属方式保持一致：

1. inline subagent：通过当前 turn 的 SDK 流透传，仍挂在父线程 stream 上
2. background / remote subagent：继续保留 `task_started / task_progress / task_notification` 容器事件
3. 两类路径最终都必须收敛到同一个 `subagent_run_id`，并由 web 侧统一聚合

---

## UI 方案

### 保持 task 卡片为主入口

当前 subagent 已经通过 task 卡片渲染，这个入口应继续保留。

原因：

1. 用户已经建立了 “subagent = task card” 的认知
2. 不会干扰主消息流
3. 与当前 Team Activity / Tool Activity 体系一致

### 卡片内容升级

`TaskContainerCard` 增加四个区块：

1. 顶部状态条
   显示 running / completed / failed
2. Tool Activity 区
   渲染 subagent 的工具调用和工具结果
3. Thinking 区
   渲染 subagent 的思考流
4. 正文输出区
   渲染 subagent 的文本正文流与最终正文

### 不建议的做法

本轮不建议：

1. 把 subagent 输出直接拼进主 assistant 的 `MessageResponse`
2. 把 subagent 透传事件混入主 assistant 的 `currentAgentStreamState`

这样会导致：

1. 主线程正文和 subagent 正文混流
2. 排序与折叠逻辑变复杂
3. streaming 完成后的稳定提交容易抖动

---

## File Structure

### SDK Files

- Modify: `packages/sdk/src/types.ts`
  - 为透传事件补充 `subagent_run_id` 等兼容字段定义。
- Modify: `packages/sdk/src/tools/agent-tool.ts`
  - 复用 sidecar 传入的统一 `subagent_run_id`。
  - 在 subagent 循环中透传 `assistant / stream_event / tool_result / system` 事件。
- Modify: `packages/sdk/src/engine.ts`
  - 如有需要，仅补充对透传字段的生成/保留，不重写主循环。

### Sidecar Files

- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/run.ts`
  - 生成唯一 `subagent_run_id` 并透传给 SDK `AgentTool`。
  - 保持 run registry / announce / 流式事件使用同一个 run id。
- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts`
  - 保持透传事件原样上送，必要时补日志与归属字段透传。
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
  - 确保 subagent 流事件能随主线程流进入 transcript / live stream。
  - 在最终 assistant message 投影时排除带 `subagent_run_id` 的 assistant / reasoning 事件。
  - 明确保留可用于回放的最小必要 subagent 透传事件。
- Modify: `apps/sidecar/src/services/agent/subagents/subagent-announce-service.ts`
  - 保持完成后摘要逻辑，但避免和实时正文区职责冲突。

### Web State / Render Files

- Modify: `apps/web/lib/agent-streaming.ts`
  - 新增按 `subagent_run_id` 聚合子流的状态模型。
- Modify: `apps/web/components/agent/hooks/useAgentStreamSubscriptions.ts`
  - 接收并写入 subagent 子流状态。
- Modify: `apps/web/lib/agent-tool-activity.ts`
  - 支持从透传事件中抽取 subagent 专属工具活动。
- Modify: `apps/web/components/agent/TaskContainerCard.tsx`
  - 在卡片中新增正文 / thinking / 工具详情渲染区。
- Modify: `apps/web/components/agent/AgentMessages.tsx`
  - 将聚合后的 subagent 子流挂到对应 task card。

### Tests

- Modify or add:
  - `packages/sdk/tests/agent-tool-subagent-output.test.mjs`
  - `packages/sdk/src/tools/agent-tool.test.ts`
- Modify:
  - `apps/web/lib/agent-streaming.test.ts`
  - `apps/web/components/agent/agent-team-activity.test.ts`
  - `apps/web/components/agent/TaskProgressCard.test.ts`
  - `apps/sidecar/src/services/agent/subagents/subagent-announce-service.test.ts`
  - `apps/sidecar/src/services/agent/agent-service.test.ts`（如需覆盖最终投影过滤逻辑）

---

## 分阶段实施

### Phase 1: 先打通 subagent assistant text 流

目标：

1. task 卡中先能实时看到 subagent 文本正文
2. 不要求 thinking 和工具树完全就位

交付标准：

1. subagent 执行时，task 卡内出现增量文本
2. 完成后文本稳定保留

### Phase 2: 补齐 thinking 和工具活动

目标：

1. task 卡能展示 subagent thinking
2. task 卡能展示 subagent 自己的工具调用树和结果

交付标准：

1. `tool_use -> tool_result` 在 task 卡内可回放
2. thinking 与正文顺序基本稳定

### Phase 3: 优化完成态与回放

目标：

1. announce 摘要和实时正文协同，而不是重复
2. persisted message 回放时仍能重建 task 卡内容

交付标准：

1. 刷新页面后，已完成 subagent 的结果仍可查看
2. 不发生 task 卡闪烁或内容丢失

---

## 具体任务

### Task 1: 扩展 SDK 透传 subagent 流事件

**Files:**
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/tools/agent-tool.ts`
- Test: `packages/sdk/src/tools/agent-tool.test.ts` or `packages/sdk/tests/agent-tool-subagent-output.test.mjs`

- [ ] 定义 subagent 透传事件所需的兼容字段，至少包含 `subagent_run_id`
- [ ] SDK `AgentTool` 复用 sidecar 注入的统一 `subagent_run_id`，不再内部生成第二个 run id
- [ ] 在 `AgentTool` 的 `for await (const event of engine.submitMessage(...))` 中透传 `assistant`
- [ ] 在同一循环中透传 `stream_event`
- [ ] 在同一循环中透传 `tool_result`
- [ ] 对透传事件保留 `parent_tool_use_id`
- [ ] 为透传事件补最小单测，验证父线程能收到带统一 `subagent_run_id` 的 assistant/text 事件

### Task 2: sidecar 过滤主 assistant 投影并确定回放持久化策略

**Files:**
- Modify: `apps/sidecar/src/services/pi-agent/runtime-core/run.ts`
- Modify: `apps/sidecar/src/services/agent/agent-service.ts`
- Test: `apps/sidecar/src/services/agent/agent-service.test.ts` if needed

- [ ] sidecar wrapper 生成唯一 `subagent_run_id`，并与 registry / announce / SDK 透传统一
- [ ] `projectAssistantMessageFromSdkMessages()` 排除带 `subagent_run_id` 的 assistant 事件
- [ ] `extractAssistantTextFromSdkMessages()` 排除 subagent text
- [ ] `extractAssistantReasoningFromSdkMessages()` 排除 subagent thinking
- [ ] 明确保留用于回放的最小必要 subagent 透传事件，不只依赖 announce 摘要
- [ ] 为最终投影过滤补单测，验证主 assistant 不会混入 subagent 正文

### Task 3: 在 Web streaming state 中聚合 subagent 子流

**Files:**
- Modify: `apps/web/lib/agent-streaming.ts`
- Modify: `apps/web/lib/agent-streaming.test.ts`

- [ ] 新增 `subagentStreams` 状态结构，按 `subagent_run_id` 索引
- [ ] 让 `applySdkMessage()` 能识别 subagent assistant / stream_event / tool_result
- [ ] 不把 subagent 文本并入主 assistant `content`
- [ ] 为子流记录 `content`、`reasoning`、`toolActivities`、`contentBlocks`
- [ ] 为聚合逻辑补单测，验证多个 subagent 并发时不会串流

### Task 4: 让订阅层写入 subagent 子流

**Files:**
- Modify: `apps/web/components/agent/hooks/useAgentStreamSubscriptions.ts`
- Modify: `apps/web/atoms/agent-atoms.ts` if needed

- [ ] 在 stream subscription 中保持 subagent 子流状态更新
- [ ] 保证主线程 `streaming -> final` 提交时不清空仍需展示的 subagent 完成态
- [ ] 保证错误回退路径不会抹掉 subagent 已经收到的正文

### Task 5: 升级 Task 卡片渲染

**Files:**
- Modify: `apps/web/components/agent/TaskContainerCard.tsx`
- Modify: `apps/web/components/agent/AgentMessages.tsx`

- [ ] 给 task 卡增加 subagent 正文输出区
- [ ] 给 task 卡增加 reasoning 折叠区
- [ ] 给 task 卡增加 subagent 内部工具活动区
- [ ] 完成态显示最终正文，运行中显示 streaming 正文
- [ ] 保持主消息列表稳定，不触发整表 reload 抖动

### Task 6: 保留 announce 作为完成后稳定摘要

**Files:**
- Modify: `apps/sidecar/src/services/agent/subagents/subagent-announce-service.ts`
- Modify: `apps/web/components/agent/AgentMessages.tsx`

- [ ] 保留现有 announce 完成消息
- [ ] 如果 task 卡内已有完整最终输出，announce 只展示摘要/跳转，不重复大段正文
- [ ] 刷新后优先用 persisted announce + persisted sdkMessages 恢复完成态

### Task 7: 验证完整链路

**Files:**
- Modify or add:
  - `apps/web/components/agent/TaskProgressCard.test.ts`
  - `apps/web/components/agent/agent-team-activity.test.ts`
  - `apps/sidecar/src/services/agent/subagents/subagent-announce-service.test.ts`

- [ ] 验证 subagent 工具调用能在 task 卡中出现
- [ ] 验证 subagent 文本正文能流式出现
- [ ] 验证 subagent 完成后最终输出保留
- [ ] 验证两个 subagent 并发执行时内容不串
- [ ] 验证刷新/恢复后完成态仍可见

---

## Execution Checklist

下面这份 checklist 不是替代上面的任务定义，而是把实施顺序压缩成可以直接开工的批次。建议严格按顺序推进，每一批完成后先做定点验证，再继续下一批。

### Batch 0：先统一 runId，堵住后续返工源头

**目标：** 让 registry / SDK 透传 / announce / web 聚合全部使用同一个 `subagent_run_id`。

**改动文件：**
- `apps/sidecar/src/services/pi-agent/runtime-core/run.ts`
- `packages/sdk/src/tools/agent-tool.ts`
- `packages/sdk/src/types.ts`

**执行清单：**
- [ ] sidecar wrapper 生成唯一 `subagent_run_id`
- [ ] 将该 id 透传给 SDK `AgentTool`
- [ ] `AgentTool` 不再内部生成第二套 subagent run id
- [ ] `task_started / task_progress / task_notification` 统一使用该 id
- [ ] announce / registry 统一回写该 id

**完成判定：**
- [ ] 同一个 subagent 在日志、registry、system event、announce 中的 run id 完全一致
- [ ] 两个并发 subagent 不会互相覆盖状态

### Batch 1：打通 SDK → sidecar 的原始透传

**目标：** 父线程真实收到 subagent 的 `assistant / stream_event / tool_result`。

**改动文件：**
- `packages/sdk/src/tools/agent-tool.ts`
- `packages/sdk/src/types.ts`
- `apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts`

**执行清单：**
- [ ] 给 subagent 透传事件补齐兼容字段：`subagent_run_id`、`parent_tool_use_id`
- [ ] 在 `for await (const event of engine.submitMessage(...))` 内透传 `assistant`
- [ ] 同一循环内透传 `stream_event`
- [ ] 同一循环内透传 `tool_result`
- [ ] 确保这些事件仍走父线程 stream channel

**完成判定：**
- [ ] 主线程 live stream 中能看到带 `subagent_run_id` 的透传事件
- [ ] 透传事件不破坏现有主线程 event 顺序

### Batch 2：先修 sidecar 最终投影，防止主消息被污染

**目标：** subagent 正文进入持久化/回放，但绝不混入主 assistant 最终消息。

**改动文件：**
- `apps/sidecar/src/services/agent/agent-service.ts`

**执行清单：**
- [ ] `projectAssistantMessageFromSdkMessages()` 排除带 `subagent_run_id` 的 assistant 事件
- [ ] `extractAssistantTextFromSdkMessages()` 排除 subagent text
- [ ] `extractAssistantReasoningFromSdkMessages()` 排除 subagent thinking
- [ ] 明确保留用于回放的最小必要 subagent 透传事件

**完成判定：**
- [ ] 主 assistant 最终消息只包含主线程正文
- [ ] subagent 完整正文仍可从 persisted sdkMessages 重建

### Batch 3：在 web state 中建立 subagent 子流聚合

**目标：** 前端按 `subagent_run_id` 聚合出独立子流，不混进主 streaming state。

**改动文件：**
- `apps/web/lib/agent-streaming.ts`
- `apps/web/lib/agent-streaming.test.ts`

**执行清单：**
- [ ] 新增 `subagentStreams` 状态结构
- [ ] `applySdkMessage()` 识别 subagent `assistant / stream_event / tool_result`
- [ ] 为子流记录 `content`、`reasoning`、`toolActivities`、`contentBlocks`
- [ ] 不把 subagent 文本并入主 assistant `content`
- [ ] 覆盖多 subagent 并发场景

**完成判定：**
- [ ] 多个 subagent 并行时各自内容稳定归属
- [ ] 主 assistant streaming state 不因为子流更新而膨胀

### Batch 4：订阅层接入并保住 streaming → final 稳定性

**目标：** live stream、error fallback、完成态切换都不丢 subagent 子流。

**改动文件：**
- `apps/web/components/agent/hooks/useAgentStreamSubscriptions.ts`
- `apps/web/atoms/agent-atoms.ts`（如需要）

**执行清单：**
- [ ] stream subscription 写入 `subagentStreams`
- [ ] 主线程 `streaming -> final` 提交时不清空已完成的 subagent 子流
- [ ] 错误回退路径保留已收到的 subagent 正文
- [ ] 切线程/恢复时保证状态不会串会话

**完成判定：**
- [ ] 运行中、完成后、错误后都能看到对应 subagent 卡片内容
- [ ] 不出现刷新前有内容、完成后消失的问题

### Batch 5：升级 Task 卡片，把 text / thinking / tools 真渲染出来

**目标：** Task 卡从“状态卡”升级成“完整子流容器”。

**改动文件：**
- `apps/web/components/agent/TaskContainerCard.tsx`
- `apps/web/components/agent/AgentMessages.tsx`
- `apps/web/lib/agent-tool-activity.ts`

**执行清单：**
- [ ] 为卡片接入 subagent 正文输出区
- [ ] 增加 reasoning 折叠区
- [ ] 增加 subagent 内部工具活动区
- [ ] 运行中展示 streaming 内容，完成后展示稳定 final 内容
- [ ] 维持主消息列表稳定，避免整表 reload 抖动

**完成判定：**
- [ ] task 卡能同时展示状态、工具、thinking、正文
- [ ] task 卡展开/收起不影响主消息列表稳定性

### Batch 6：让 announce 回到“摘要/跳转”职责

**目标：** announce 保留，但不和 task 卡正文重复大段内容。

**改动文件：**
- `apps/sidecar/src/services/agent/subagents/subagent-announce-service.ts`
- `apps/web/components/agent/AgentMessages.tsx`

**执行清单：**
- [ ] 保留 announce 完成消息
- [ ] task 卡已有完整输出时，announce 仅展示摘要 / 状态 / 跳转
- [ ] 刷新后优先用 persisted sdkMessages + announce 恢复完成态

**完成判定：**
- [ ] 用户不会在 task 卡和 announce 里看到重复大段正文
- [ ] 完成态回放仍稳定

### Batch 7：回归验证与 smoke

**目标：** 在关键链路上把“能展示”和“不会串”都验证掉。

**优先测试文件：**
- `packages/sdk/tests/agent-tool-subagent-output.test.mjs`
- `apps/web/lib/agent-streaming.test.ts`
- `apps/web/components/agent/TaskProgressCard.test.ts`
- `apps/web/components/agent/agent-team-activity.test.ts`
- `apps/sidecar/src/services/agent/subagents/subagent-announce-service.test.ts`
- `apps/sidecar/src/services/agent/agent-service.test.ts`

**执行清单：**
- [ ] 验证 subagent 文本正文能流式出现
- [ ] 验证 subagent thinking 能出现
- [ ] 验证 subagent 工具调用和结果能出现
- [ ] 验证两个 subagent 并发执行时内容不串
- [ ] 验证刷新/恢复后完成态仍可见
- [ ] 验证主 assistant 最终消息没有混入 subagent 正文

**建议验证顺序：**
1. 先跑 SDK / sidecar 单测
2. 再跑 web 聚合单测
3. 最后做一条端到端 smoke：主线程发起 subagent → 运行中看到正文 → 完成后保留 final 输出 → 刷新后还能回看

### 推荐提交切片

为了降低回滚成本，建议按下面顺序拆 commit / PR：

1. `Batch 0 + Batch 1`：统一 runId + SDK 透传
2. `Batch 2`：sidecar 过滤主 assistant 投影
3. `Batch 3 + Batch 4`：web 子流聚合 + 订阅接入
4. `Batch 5`：Task 卡 UI 升级
5. `Batch 6 + Batch 7`：announce 收口 + 回归验证

---

## 风险与约束

### 风险 1：主线程正文和 subagent 正文混流

控制方式：

1. 所有 subagent 事件必须按 `subagent_run_id` 单独聚合
2. 不直接写入主 assistant `content`

### 风险 2：task 卡抖动或重复渲染

控制方式：

1. task 卡内部使用局部 state / memo
2. 主消息列表不因 subagent 子流变化而全量重建

### 风险 3：完成后回放不一致

控制方式：

1. announce 继续作为稳定完成摘要
2. persisted sdkMessages 中保留足够的 subagent 原始透传事件用于重建
3. 在 sidecar 最终 assistant 投影时显式排除 subagent assistant，避免回放与实时态不一致

### 风险 4：shared contract 过度扩张

控制方式：

1. 尽量复用现有 `SDKMessage`
2. 仅增加兼容字段，不创建大而新的 message 协议

### 风险 5：runId 不统一导致 task / announce / 子流错绑

控制方式：

1. `subagent_run_id` 由 sidecar wrapper 单点生成
2. SDK / registry / announce / web 聚合统一复用该 id
3. 为统一 run id 增加最小回归测试

---

## 验收标准

满足以下条件即可视为完成：

1. subagent 运行中，task 卡内可实时看到正文
2. subagent 运行中，task 卡内可实时看到工具过程
3. subagent 运行中，task 卡内可实时看到 thinking
4. subagent 完成后，最终输出保留且可回看
5. 多个 subagent 并行执行时，内容不会串流
6. 主线程消息列表在整个过程中保持稳定，无明显抖动

---

## Self-Review

### Spec Coverage

- 当前已接入的三个核心事件：已纳入背景与现状
- 当前通过 task 卡片渲染：已纳入 UI 方案
- 目标是完整流式展示 subagent 工作流程：已拆成 SDK、状态、UI、验证四层

### Placeholder Scan

- 无 `TODO`
- 每个阶段和任务都有明确目标与文件范围

### Type Consistency

- 统一使用 `subagent_run_id`
- 统一使用 `TaskContainerCard` 作为 subagent 主展示容器
- 统一将“实时正文”与“完成摘要”区分为两层职责
