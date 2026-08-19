# Agent 事件总线 · 批次4(task_notification + compaction 迁移)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 task_notification(非 subagent 形态)与 compaction 三态迁上事件总线——消灭 task_notification 的 live 双投与 P7 旁路乱序(双入口注入收编进 seq 单调),消除 compaction 乱序回退文案。

**Architecture:** task_notification 有两个入口(engine 二选一,无双发):in-run 走主流(projector 投影)、late 走 onAsyncEvent 旁路(run.ts handleAsyncEvent 直发 bus——批次3 第二注入路径同构);两处 publish 到同一 bus,seq 单调天然归一(这正是 P7 的根治)。compaction 全程在主流,projector 投影。web 适配器产旧路等价 RuntimeEvent(background.task.completed/context.compaction.*),跳过清单扩展;sidecar 内部消费(runtimeStatusManager/trace/SDK log 双写)不动(旧路照发)。

**Tech Stack:** 同批次1-3。

**Spec:** `docs/superpowers/specs/2026-08-15-agent-event-bus-design.md`(§3.2 领域事件行、§7 批次4 行——范围按本计划实证收窄,api_retry/memory_saved/init/status 不迁,裁决依据见计划背景)

## Global Constraints

- 事件类型单源 `agent-events.ts`;批次1-3 机制零改动复用;flag off 零行为变化
- 骨架事件:`kind:'run', phase:'event', turnId:null`(批次3 裁定先例);task_notification 主流版在 tool 执行期间到达——turnId 归属当前 turn 还是 null?**裁定:null**(与 background 语义一致,turn 归属对它无意义且 late 版无 turn 上下文,统一 null 避免两入口语义分叉)
- subagent 形态(subagent_run_id 非空)的 task_notification **不迁**(独立闭环 SUBAGENT_COMPLETED;projector 现有 subagent 跳过已覆盖主流版;handleAsyncEvent 注入处同样判跳)
- compaction 迁移只覆盖 web 渲染通道;sidecar 内部(runtimeStatusManager/sessionStateManager/trace span/SDK log 双写)零改动
- 旧路等价基准:background.task.completed(`run-item-events.ts:569-593`,id 恒 `background-task:${threadId}:${taskId}:completed`——总线版 id 用 `lifecycle:{seq}:` 前缀,web 端 streaming 副作用对齐);context.compaction.started/progress/completed(`run-item-events.ts:475-536`)
- web 适配器新增 streaming 副作用:background.task.completed(status completed/stopped→idle;failed→errored)对齐旧路 `useGlobalAgentListeners.ts:259-262`
- commit emoji + `Co-Authored-By: Claude <noreply@anthropic.com>`
- 分支 `feat/agent-event-bus-batch4`(栈式基于批次3 head 515c0cd7)

## 已知事实(执行者必读)

- **双入口**(engine.ts:1654-1666 旁路开关):toolCallActive=false 时 task_notification 走 `config.onAsyncEvent` 不进主流;in-run 版在主流。**同一事件只走一个入口**
- 旁路汇点:`run.ts` handleAsyncEvent(~:1796,已处理 task_notification 的续跑 checkpoint 与 emitSdkMessage)——bus 注入加在此
- projector 现状:system 类全部 `default: break` 跳过(`lifecycle-projector.ts:251-269`);task_notification/compaction 需新增分支(注意:projector 的 subagent 判重在入口,subagent 版天然被跳过)
- SDK 消息形态:`SDKTaskNotificationMessage{task_id,tool_use_id,status,message/summary,execution}`(types.ts);compaction 三态消息(engine.ts:658-745 工厂)
- bus 注入先例:批次3 lume-runner 双发(`void publish().catch(log.warn)`);run-loop tee(主流);handleAsyncEvent 处可拿 sessionDir/threadId(续跑 checkpoint 代码已在用)
- web 投影:compaction upsert 幂等(compactionMessageByRun);background.task.completed 无消息投影(仅 streaming 态);适配器事件 id `lifecycle:{seq}:` 前缀
- 跳过清单现 9 类型(`useGlobalAgentListeners.ts:73-88`)

---

### Task 1: shared 批次4 领域事件类型

**Files:**
- Modify: `packages/shared/src/types/agent-events.ts`
- Test: `packages/shared/src/types/agent-events.test.ts`(追加)

**Interfaces:**
- Produces:

```ts
export interface BackgroundTaskNotificationDetail {
  type: 'background.task'
  taskId: string
  status: 'completed' | 'failed' | 'stopped' | 'cancelled'
  message?: string
  summary?: string
  execution?: unknown
}

export interface ContextCompactionDetail {
  type: 'context.compaction'
  phase: 'started' | 'progress' | 'completed'
  /** progress 百分比(45/85)或完成态文本 */
  progress?: number
  /** completed 态:成功或失败文案 */
  result?: string
  isError?: boolean
}
```

两类型入 `SdkLifecycleDetail` 联合。

- [ ] **Step 1**: 失败测试(两类型可赋值+判别,照批次3 模式)
- [ ] **Step 2**: 红(文件级 tsc)
- [ ] **Step 3**: 实现
- [ ] **Step 4**: 绿+shared 全量(162 基线)
- [ ] **Step 5**: Commit `✨ feat(shared): 批次4 领域事件类型(background.task/context.compaction)`

### Task 2: SDK projector 主流投影(compaction×3 + in-run task_notification)

**Files:**
- Modify: `packages/sdk/src/events/lifecycle-projector.ts`
- Test: `packages/sdk/src/events/lifecycle-projector.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 类型;SDK 流消息(compaction 三态/task_notification)
- Produces:
  - compaction started/progress/boundary 消息 → `context.compaction` 骨架(phase 对应;boundary 成功→completed+result/isError:false,失败→completed+isError:true)
  - in-run task_notification(无 subagent_run_id)→ `background.task` 骨架(status 只映射 completed/failed/stopped/cancelled 四态——**attention 被丢弃**(旧路同语义,run-item-events.ts:587-593);其他 status 忽略)
  - 两类 kind='run'/phase='event'/turnId=null;**不参与 turn 配对/闭合**(纯领域事件,与 message/tool 流正交)

- [ ] **Step 1**: 失败测试 4 用例:①compaction started+progress+boundary 成功 → 3 骨架(phase 序);②boundary 失败 → isError:true;③in-run task_notification completed → 骨架字段;④attention/unknown status → 不产;⑤subagent 形态 → 不产(projector 入口已有跳过,断言兜底)
- [ ] **Step 2**: 红
- [ ] **Step 3**: 实现(新增两 case 分支,subagent 入口跳过复用)
- [ ] **Step 4**: 绿+SDK 全量(464 基线)
- [ ] **Step 5**: Commit `✨ feat(sdk): projector 投影 compaction 与 in-run task_notification 领域事件`

### Task 3: sidecar 旁路注入(late task_notification)+ web 适配 + 跳过清单

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`(handleAsyncEvent task_notification 分支加 bus.publish)
- Modify: `apps/web/src/hooks/lifecycle-event-adapter.ts`(两映射分支+streaming 副作用)
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`(跳过清单 +4:background.task.completed/context.compaction.started/progress/completed)
- Test: `apps/sidecar/src/rpc/agent-handlers.events.test.ts` 或新文件(旁路注入);`apps/web/src/hooks/lifecycle-event-adapter.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1/2;`getThreadEventBus(sessionDir).publish`;flag `isAgentLifecycleEventsEnabled()`
- Produces:
  - run.ts handleAsyncEvent:task_notification(无 subagent_run_id 且四态)flag on 时 `void publish(threadId, LumeRunId, {kind:'run',phase:'event',turnId:null,detail:{type:'background.task',...}}).catch(log.warn)`——**与 projector 主流版同一 detail 形态**;seq 由同一 bus 单调分配(双入口归一)
  - 适配器:background.task → `background.task.completed`(id=`lifecycle:{seq}:`,**保留旧路恒定 id 的去重语义做不到(无 taskId 稳定键跨入口)——但两入口同一事件只走其一,无双发**;字段 status/message);context.compaction → started/progress/completed 三态 RuntimeEvent(对齐 run-item-events 字段,执行时读该文件对齐)
  - consumeBusEnvelope streaming 副作用:background.task completed/stopped→idle、failed→errored(对齐旧路)
  - 跳过清单 +4(注释"批次4 扩")

- [ ] **Step 1**: 失败测试(sidecar:late 通知 flag on→publish、off→无、subagent→无;web:两映射字段/streaming 副作用/未知忽略)
- [ ] **Step 2**: 红
- [ ] **Step 3**: 实现
- [ ] **Step 4**: 绿+sidecar/web 全量+typecheck
- [ ] **Step 5**: Commit `✨ feat: 批次4 双入口注入+web 适配(background.task/compaction)`

### Task 4: 回归与收尾

- [ ] **Step 1**: 四包全量+typecheck(controller 直跑)
- [ ] **Step 2**: spec §7 批次4 行更新(已完成态+范围裁决记录:api_retry/memory_saved/init/status 不迁及依据)——controller 直落(纯文档)
- [ ] **Step 3**: 手动冒烟留验收(后台任务/压缩场景)

## 验收(整体)

1. 四包绿+typecheck;flag off 零变化
2. late task_notification 的 runtime-event 列表重复条目消失(live 双投修复);`[lifecycle-mismatch]` 新增类型不触发(turnId=null 领域事件过闸门?——注意:background.task.completed 不在 TERMINAL_REBUILDING 集合,不受闸门影响,验收确认无打点)
3. compaction 乱序回退消除(seq 单调下 progress 不晚于 completed)

## 任务依赖

Task 1 → Task 2 → Task 3 → Task 4(线性)
