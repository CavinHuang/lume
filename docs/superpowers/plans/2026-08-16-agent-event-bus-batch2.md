# Agent 事件总线 · 批次2(tool 三段式迁移)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 tool 生命周期迁上事件总线(tool.start/tool.end 骨架),web 试点线程的 tool 渲染改由总线驱动(旧路 tool.started/completed/failed 跳过)——消灭双源治理(方向 C)的 tool 类收敛。

**Architecture:** 沿批次1 模式:shared 类型扩展 → SDK projector 产 tool 骨架(推断时机:assistant 终值的 tool_use → tool.start;对应 tool_result → tool.end)→ web 适配器转旧路等价 RuntimeEvent(字段对齐 run-item-events.ts 现形态)→ 跳过清单扩展。tool.update(流式部分结果)在 SDK 流中不存在(tool_progress 是完成标记),批次2 不做——骨架语义留位,发现真实信号源再启用(YAGNI)。

**Tech Stack:** 同批次1(bun workspace / bun:test / @lume/shared 单源类型)。

**Spec:** `docs/superpowers/specs/2026-08-15-agent-event-bus-design.md`(§3.2 骨架全集、§7 路线图批次2 行)

## Global Constraints

- 事件类型单源 `packages/shared/src/types/agent-events.ts`;信封/seq/微批/"快照不注入"/终态闸门等批次1 机制**零改动复用**
- flag `AGENT_LIFECYCLE_EVENTS` 不变;flag off 零行为变化
- **子 agent 决策(批次2 裁定)**:`subagent_run_id` 非空的事件**继续跳过不进总线**——子 agent UI 走 SUBAGENT_COMPLETED/WORK_CHANGED 独立通道,与试点链无关;归属重新评估留批次4
- **tool_use_summary 不吞并**:engine:1467 的 tool_use_summary 事件保持旧路不动(批次2 不动它的消费方)
- 旧路等价字段以 `apps/sidecar/src/services/agent-runtime/runner/run-item-events.ts:203-258` 为准(tool.started: toolCallId/toolName/inputPreview/riskLevel;tool.completed: resultPreview/execution/resultRef;tool.failed: error.code=tool_error/message=preview)
- 适配器事件 id 前缀 `lifecycle:{seq}:` 不变(线程内唯一、跨重放稳定)
- commit emoji 前缀 + `Co-Authored-By: Claude <noreply@anthropic.com>`
- 分支 `feat/agent-event-bus-batch2`(基于批次1 head 5ddd321a;PR 栈式或待 PR#93 合并后 rebase,执行时看状态)

## 已知事实(执行者必读)

- projector:`packages/sdk/src/events/lifecycle-projector.ts`——批次1 已有 PendingTurn(toolUseIds Set/混合配对/turnId=turn-N);tool 骨架在此扩展
- SDKToolResultMessage(`packages/sdk/src/types.ts:121-132`):`result: { tool_use_id, tool_name, output, content?, is_error?, _meta? }`——**_meta.execution 是旧路 execution/resultRef 的来源**(run-item-events 的 normalizeToolExecutionMetadata 消费它)
- 旧路 tool.started 的 item.createdAt 来自 tool_call item(observer 从 assistant tool_use 推断)——projector 的 tool.start 同样是推断时机(assistant 终值后),与旧路语义一致
- web 跳过清单:`apps/web/src/hooks/useGlobalAgentListeners.ts` 的 `LEGACY_SKIPPED_PILOT_EVENT_TYPES`(现 5 类)
- 适配器:`apps/web/src/hooks/lifecycle-event-adapter.ts`——Batch1LifecycleDetail 判别;投影消费 tool.started/completed/failed(runtime-event-message-projection.ts 已支持,零改动)
- 终态闸门 `TERMINAL_REBUILDING_EVENT_TYPES`(批次1,16 类)已含 tool.started/completed/failed——tool 骨架沿用其保护,无需改

---

### Task 1: shared tool 骨架类型

**Files:**
- Modify: `packages/shared/src/types/agent-events.ts`
- Test: `packages/shared/src/types/agent-events.test.ts`(追加)

**Interfaces:**
- Produces(Task 2/3 依赖):

```ts
export interface ToolStartDetail {
  type: 'tool.start'
  toolCallId: string
  toolName: string
  /** 与旧路 inputPreview 对齐:原始输入(投影层做 preview 裁剪) */
  input: unknown
}

export interface ToolEndDetail {
  type: 'tool.end'
  toolCallId: string
  toolName: string
  isError: boolean
  /** 与旧路 resultPreview 对齐:output 文本 */
  output: string
  /** engine _meta.execution 原样透传(旧路 normalizeToolExecutionMetadata 的输入) */
  meta?: Record<string, unknown>
}
```

并把两类型加入 detail 联合(现名 `Batch1LifecycleDetail`——**更名为 `SdkLifecycleDetail`** 并全仓更新引用,grep `Batch1LifecycleDetail` 共享/sdk/web 三处;更名保持语义清晰,引用点少)。

- [ ] **Step 1: 写失败测试**(追加:类型编译级——新类型的字段存在性与联合成员判定,参考现有 agent-events.test.ts 风格;至少断言 `const d: SdkLifecycleDetail = { type: 'tool.start', toolCallId: 't1', toolName: 'Bash', input: {} }` 可赋值且 kind 判别正确)
- [ ] **Step 2: 红** → `cd packages/shared && bun test src/types/agent-events.test.ts`
- [ ] **Step 3: 实现**(新增两类型+联合更名+全仓引用更新)
- [ ] **Step 4: 绿 + shared 全量**(159+ 基线;sdk/web 因更名需 typecheck 复绿——本步只验 shared,引用更新在 Step 3 一并完成)
- [ ] **Step 5: Commit** `✨ feat(shared): tool 骨架 detail 类型;Batch1LifecycleDetail→SdkLifecycleDetail`

### Task 2: SDK projector 产 tool 骨架

**Files:**
- Modify: `packages/sdk/src/events/lifecycle-projector.ts`
- Test: `packages/sdk/src/events/lifecycle-projector.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 类型;现有 SDKMessage 流
- Produces: assistant 终值(带 tool_use)→ 每个未 start 的 tool_use 发 `tool.start`(turnId 归属当前 turn);`tool_result` 事件 → 发 `tool.end`(isError/output 从 result 取,meta=result._meta);**turn.end 闭合时序不变**(全部 tool.end 先于 turn.end——现有配对逻辑天然保证)

- [ ] **Step 1: 失败测试**(追加 3 用例:①assistant 带 2 工具 → 2×tool.start 在 message.end 后、turn.end 前,顺序=tool_use 序,字段 toolCallId/input 对齐;②tool_result → tool.end(is_error/output/meta 透传);③失败路径 tool_result is_error=true → tool.end isError=true。骨架序列断言含 tool 事件:`run.start,turn.start,message.start,…,message.end,tool.start×2,tool.end×2,turn.end,run.end`)
- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**——PendingTurn 增加 `startedToolIds: Set<string>`;handleAssistant 的 tool_use 提取处逐个发 tool.start(在 message.end 事件之后按 content 序);handleToolResult 发 tool.end 后走现有配对闭合
- [ ] **Step 4: 绿 + SDK 全量**(批次1 后基线,零回归)
- [ ] **Step 5: Commit** `✨ feat(sdk): projector 产 tool.start/tool.end 骨架`

### Task 3: web 适配器转旧路等价 + 跳过清单扩展

**Files:**
- Modify: `apps/web/src/hooks/lifecycle-event-adapter.ts`
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`(LEGACY_SKIPPED_PILOT_EVENT_TYPES + 注释更新)
- Test: `apps/web/src/hooks/lifecycle-event-adapter.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 类型(envelope.detail.type='tool.start'/'tool.end')
- Produces: tool.start → `tool.started`(id=`lifecycle:{seq}:tool.started`,toolCallId/toolName/inputPreview=input/riskLevel 可省——投影不消费则不填,执行者查投影消费字段后决定,报告记录);tool.end → isError ? `tool.failed`(error:{code:'tool_error',message:output}) : `tool.completed`(resultPreview=output;**execution/resultRef 不做**——旧路从 _meta 经 normalizeToolExecutionMetadata 构造,web 侧无该函数,首版省略并在报告记录减配:试点线程工具结果的大结果文件链接缺失,批次2.1 补);跳过清单 + `tool.started/completed/failed`

- [ ] **Step 1: 失败测试**(适配器纯函数:tool.start envelope → tool.started RuntimeEvent 字段断言;tool.end 成功/失败两分支;未知 detail 忽略不变)
- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**(adaptLifecycleEvent 加两分支;跳过清单扩三类型,注释更新"批次2 扩")
- [ ] **Step 4: 绿 + web 全量**(1203+ 基线)+ typecheck
- [ ] **Step 5: Commit** `✨ feat(web): 试点线程 tool 渲染切总线(适配+跳过清单批次2 扩展)`

### Task 4: 端到端验证与收尾

**Files:**
- 无新文件;Test: 各层既有测试全量回归

- [ ] **Step 1**: 四包全量+typecheck(shared/sdk/sidecar/web;sidecar 本任务零改动,跑基线确认)
- [ ] **Step 2**: flag on 手动冒烟(执行环境允许时):dev 起后发带工具任务,观察工具卡片渲染正常(工具名/输入/结果预览)、无 duplicate;环境不允许则标注留验收
- [ ] **Step 3**: Commit(如有修正)`🐛 fix: 批次2 端到端修正`(无则跳过)

## 验收(整体)

1. 四包测试全绿、typecheck 绿;flag off 零变化
2. 试点线程 tool 事件由总线单源驱动(旧路三类型跳过);`[lifecycle-mismatch]` 打点中 tool.* 类错位计数应开始下降(并行期护栏对 tool 不再需要触发)
3. 已知减配留档:execution/resultRef 大结果链接(批次2.1)

## 任务依赖

Task 1 → Task 2 → Task 3 → Task 4(严格线性)
