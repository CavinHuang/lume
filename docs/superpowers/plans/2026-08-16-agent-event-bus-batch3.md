# Agent 事件总线 · 批次3(memory 事件迁移+消费端裁定转正)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `memory.context.used`(批次1 验收实测的错位高发类)迁上事件总线,消灭其双路错位源头;同时把批次2 留下的两个消费端裁定项转正为文档化语义。

**Architecture:** memory 数据源在 session 层(`createRuntimeCoreSessionResult.memoryContextUsedItems`)而非 SDK 消息流——本批新增**第二条注入路径**:lume-runner 在现有 emitMemoryContextUsed 处同步 bus.publish(kind='event' 骨架事件);web 适配器消费并映射,跳过清单扩展。投影的 memory 分支为 filter+push 幂等设计,hydrate 双投天然吸收。`memory.changed`/`memory.job.*` 不迁(它们走版本计数非渲染路径,无双投,YAGNI);交互事件(权限/ask_user)不迁(专用闭环通道单源,迁移需重建闭环,无收益——对 spec 路线图批次3 行的修正裁决)。

**Tech Stack:** 同批次1/2。

**Spec:** `docs/superpowers/specs/2026-08-15-agent-event-bus-design.md`(§3.2 领域事件行、§7 批次3 行——范围按治本裁决收窄,裁决记录见本计划)

## Global Constraints

- 事件类型单源 `agent-events.ts`;批次1/2 机制零改动复用
- flag `AGENT_LIFECYCLE_EVENTS` 不变;flag off 零行为变化(sidecar 双发在 flag on 才 bus.publish)
- kind='event' 骨架事件:phase='event',turnId=null(run 级领域事件)
- 交互事件(权限/ask_user/browser_auth/desktop_action)**不迁**——专用闭环通道,单源无双投(修正裁决)
- `memory.changed`/`memory.job.*` **不迁**(YAGNI,记录)
- commit emoji + `Co-Authored-By: Claude <noreply@anthropic.com>`
- 分支 `feat/agent-event-bus-batch3`(栈式基于批次2 head d09a0d67)

## 已知事实(执行者必读)

- 双产生点:live `lume-runner.ts:599 emitMemoryContextUsed`(items 来自 session 创建结果,run 开始时发,`hidden:true`)+ replay `run-item-events.ts:411`(hydrate 路径,批次1 验收的双投错位源)
- bus 注入现状:run-loop tee 只覆盖 SDK 流;ThreadEventBus 实例经 `getThreadEventBus(sessionDir)` 获取(sidecar events/thread-event-bus.ts)
- lume-runner 持有 observer(threadId/workspaceSlug 可得);sessionDir 的解析先例在 agent-handlers `resolveRuntimeSessionDir`(单参 getRuntimeCoreSessionDir)——lume-runner 若无 sessionDir 需查其构造参数(执行时确认,选最小传递路径)
- web 投影 memory 分支(runtime-event-message-projection.ts:144)filter+push 幂等(按 block 类型清再 push),跨 id 双投被 filter 吸收
- 终态闸门含 memory.context.used(批次1)——终态后到达仍被挡,迁移后语义不变

---

### Task 1: shared MemoryContextUsedDetail 类型

**Files:**
- Modify: `packages/shared/src/types/agent-events.ts`
- Test: `packages/shared/src/types/agent-events.test.ts`(追加)

**Interfaces:**
- Produces:

```ts
export interface MemoryContextUsedDetail {
  type: 'memory.context.used'
  /** 与旧路 event.items 同构:memory 引用条目列表 */
  items: Array<{
    id: string
    kind: string
    scope: string
    status: string
    citation: string
    fileRef?: unknown
    reason?: string
    claim?: string
  }>
}
```

加入 `SdkLifecycleDetail` 联合。

- [ ] **Step 1**: 失败测试(类型可赋值+判别,同批次2 Task 1 模式)
- [ ] **Step 2**: 红(文件级 tsc,shared tsconfig 排除 test 的既有约束)
- [ ] **Step 3**: 实现(类型+入联合)
- [ ] **Step 4**: 绿+shared 全量(161 基线)
- [ ] **Step 5**: Commit `✨ feat(shared): MemoryContextUsedDetail 领域事件类型`

### Task 2: sidecar 第二注入路径(lume-runner 双发)

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts`(emitMemoryContextUsed 处)
- Test: `apps/sidecar/src/services/agent-runtime/runner/lume-runner.memory-bus.test.ts`(新;mock 模式参考 runner 既有测试)

**Interfaces:**
- Consumes: Task 1 类型;`getThreadEventBus(sessionDir).publish(threadId, runId, event)`;flag `isAgentLifecycleEventsEnabled()`(run-loop.ts:23,runner 已可 import)
- Produces: flag on 时,emitMemoryContextUsed 在发旧路事件的**同时** bus.publish 一个 `{kind:'event', phase:'event', turnId:null, runId:<Lume runId>, detail:{type:'memory.context.used', items}}`;flag off 不 publish

- [ ] **Step 1**: 失败测试(flag on → bus 收到 publish,detail.items 同构;flag off → 无 publish;mock bus 或用临时 sessionDir 实例)
- [ ] **Step 2**: 红
- [ ] **Step 3**: 实现——emitMemoryContextUsed 内加 flag 检查+publish;**注意 runId 用 Lume runId**(observer.getRunId(),与信封 runId 语义一致——这修正了批次1 projector 自产 UUID 的错位,领域事件从正确的 id 开始);sessionDir 获取:查 lume-runner 构造/现有字段(执行时确认最小路径,报告记录)
- [ ] **Step 4**: 绿+sidecar 全量(whoami 截断预存)+typecheck
- [ ] **Step 5**: Commit `✨ feat(sidecar): memory.context.used 经第二注入路径上总线`

### Task 3: web 适配+跳过清单+裁定转正

**Files:**
- Modify: `apps/web/src/hooks/lifecycle-event-adapter.ts`(memory 映射分支)
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`(跳过清单 +memory.context.used)
- Modify: `docs/superpowers/specs/2026-08-15-agent-event-bus-design.md`(§7 批次3 行更新:范围收窄裁决+两个消费端裁定转正)
- Test: `apps/web/src/hooks/lifecycle-event-adapter.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 detail;批次2 适配器模式
- Produces: memory envelope → `{id:'lifecycle:{seq}:memory.context.used', type:'memory.context.used', threadId,runId,createdAt, items: detail.items}`(旧路等价,live 由总线单源);跳过清单 +memory.context.used

**裁定转正内容(spec §7 更新)**:
- 批次3 范围裁决:交互事件不迁(闭环单源)/memory.changed/job 不迁(YAGNI)/memory.context.used 迁移(打点实锤)
- error assistant 悬空卡:**转正**——总线不发未执行工具的 tool.start 为正式语义(旧路悬空卡为缺陷,批次5 删旧路后全库一致)
- 孤立 tool_result:**转正**——不产 tool.end(无 start 的 end 无意义),终态闸门与 orphan guard 为正式语义

- [ ] **Step 1**: 失败测试(memory envelope 映射字段断言;未知 detail 忽略不变)
- [ ] **Step 2**: 红
- [ ] **Step 3**: 实现(映射分支+跳过清单+spec §7 更新)
- [ ] **Step 4**: 绿+web 全量(1207 基线)+typecheck
- [ ] **Step 5**: Commit `✨ feat(web): memory 事件切总线+批次3 裁定转正入 spec`

### Task 4: 回归与收尾

- [ ] **Step 1**: 四包全量+typecheck(controller 直跑)
- [ ] **Step 2**: flag on 手动冒烟留验收说明(memory 调用的展示正常、无 duplicate)

## 验收(整体)

1. 四包绿+typecheck;flag off 零变化
2. `[lifecycle-mismatch]` 打点:memory.context.used 类错位应归零(本批收敛)
3. spec §7 含三个转正裁定

## 任务依赖

Task 1 → Task 2 → Task 3 → Task 4(线性)
