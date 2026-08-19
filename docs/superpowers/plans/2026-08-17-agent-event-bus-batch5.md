# Agent 事件总线 · 批次5(终局收敛)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三阶段终局收敛——A 表 14 类全部定案(迁/裁)、runId 统一与减配补齐、删除旧路(投影开关盒/双存储/flag/闸门/打点)并完成散落治理(白名单单源/归一收编/emit 收编),兑现双层模型终态。

**Architecture:** 沿批次1-4 模式扩展迁移(Phase A/B),然后一次性删除(Phase C)——删除的前置是 A 表全部定案,不允许删一半。双层模型:骨架(传输)+RuntimeEvent(视图,零改动)+适配器(唯一翻译点)。散落治理在删除后收尾,保证删除时旧路代码不再被引用。

**Tech Stack:** 同批次1-4(bun workspace / bun:test / @lume/shared)。

**Spec:** `docs/superpowers/specs/2026-08-15-agent-event-bus-design.md` **§9 终局设计**(本计划的权威依据;§7 路线图为历史)

## Global Constraints

- **执行前置(硬性)**:T2 及之后所有任务必须在 #93→#94→#95→#97(+#99 与本计划所在 docs 分支)全部合并后的新 main 上开分支执行;**T1 取证可先行**(纯调研,零代码)
- 双层模型铁律:**`runtime-event-message-projection.ts` 与 web UI 组件零改动**(验收第 6 条,diff 断言)——一切迁移经适配器
- 删除前置铁律:T7 执行前 A 表终表(spec §9.3)必须全部"已迁/已裁定死",无"待定"
- commit emoji + `Co-Authored-By: Claude <noreply@anthropic.com>`
- 各任务先跑所在包基线再对比(基线数字以合并后 main 实测为准,本计划不预写)

## 已知事实(执行者必读)

- 迁移模式先例:类型(shared detail)→projector(主流)/第二入口(sidecar 非 SDK 流源)→适配器映射→跳过清单——批次2(tool)/3(memory)/4(task_notification+compaction)三份完整样板,遇到形态问题先翻对应批次的 plan/report
- projector:`packages/sdk/src/events/lifecycle-projector.ts`(批次4 后含 run/turn/message/tool/compaction/task_notification 分支;流中止无 result 不补发 run.end 是已知遗留,T3 修)
- 注入入口四个:run-loop tee(主流)/lume-runner(memory)/handleAsyncEvent(late task_notification)/(本批新增:lsp/coding.report 按终表)
- 适配器:`apps/web/src/hooks/lifecycle-event-adapter.ts`;跳过清单:`useGlobalAgentListeners.ts`(现 13 类)
- 旧路 emit 点(Phase C 收编对象):run-observer.ts(recordSdkMessage)/run-item-events.ts(投影)/lume-runner.ts(memory 双发)/run.ts(handleAsyncEvent)/agent-service.ts(late)/extractor+consolidation(memory_saved)
- 三处白名单:`shared/types/agent.ts AGENT_IPC_CHANNELS` / `apps/desktop/src/renderer-sidecar-methods.ts PUBLIC_RENDERER_SIDECAR_METHODS` / `apps/desktop/src/preload.ts ALLOWED_RENDERER_EVENT_CHANNELS`
- status 归一三份:`run-item-events.ts:587-593` / `lifecycle-projector.ts:~54` / `run.ts:~1749`(批次4 留档)
- 闸门+打点:`runtime-event-message-projection.ts` TERMINAL_REBUILDING_EVENT_TYPES + `[lifecycle-mismatch]`

---

### Task 1: 五类取证定案(可先行,不依赖合并)

**Files:**
- Modify: `docs/superpowers/specs/2026-08-15-agent-event-bus-design.md`(§9.3 终表更新)
- 产出: `.superpowers/sdd/<workspace>/t1-research.md`(取证报告)

**Interfaces:**
- Produces: A 表终表(迁/裁+一句依据),后续任务的范围内围栏

- [ ] **Step 1**: 对五类逐一取证(模式同批次4 取证报告:①产生点②web 消费点+投影分支③双投/乱序/回放突现面):
  - `coding.report.updated`:sidecar 产生点(codingRunTracker);web 消费(投影 codingReport 合并);终态后修补语义(闸门甄别);双源面
  - `usage.updated`:产生点/消费(若有)/双源面
  - `im.delivery` / `guidance.delivered` / `desktop.action_visual`:三盲区类(从未进视野)——产生点/web 消费(runtime-event-state 的 projectDesktopActionVisualEvent 等)/双源面
- [ ] **Step 2**: 依据判据(无双投/乱序/突现面→裁;有→迁)出终表;边界情形(低频有消费)倾向**裁**(批次5 是收敛批,新迁类越多删除风险越大,YAGNI)
- [ ] **Step 3**: spec §9.3 更新为终表(含依据);plan 的 T3-T5 范围按终表对号
- [ ] **Step 4**: commit `📝 docs: 批次5 T1 五类取证终表(A 表定案)`

### Task 2: shared 类型扩展(Phase A)

**Files:**
- Modify: `packages/shared/src/types/agent-events.ts`
- Test: `packages/shared/src/types/agent-events.test.ts`

**Interfaces:**
- Produces(按 T1 终表,以下为预判全量,裁掉的类不建):

```ts
// MessageUpdateDetail 扩展
partial: { text: string; thinking: string; toolUses: [...] }  // +thinking 折叠(批次2 遗留)

// user 消息对(run.cancelled 前置)
export interface UserMessageDetail { type: 'user.message'; content: string | unknown[] }

// 领域事件
export interface PlanPreviewDetail { type: 'plan.preview'; content: unknown }
export interface TodoStateDetail { type: 'todo.state'; state: unknown }
export interface TaskProgressDetail { type: 'task.progress'; taskId: string; ... }
export interface AdvisorReviewedDetail { type: 'advisor.reviewed'; ... }
export interface LspDiagnosticsDetail { type: 'lsp.diagnostics'; ... }
// +T1 终表判迁的 coding.report/usage/im/guidance/desktop_visual detail
```

- ContextCompactionDetail 扩 `trigger`/`outcome`(Low-1/2 减配);ToolEndDetail.meta 已有(execution/resultRef 消费在适配器)
- `MemoryContextUsedDetail.claim?: string` 改 `claim?: unknown`(F2 最小修,不动 sidecar)

- [ ] Step 1-5: 失败测试(各类型判别+thinking.partial 字段)→红(文件级 tsc)→实现→绿+shared 全量→commit `✨ feat(shared): 批次5 领域事件类型全量+减配字段`

### Task 3: projector 扩展(Phase A+B)

**Files:**
- Modify: `packages/sdk/src/events/lifecycle-projector.ts`
- Test: `packages/sdk/src/events/lifecycle-projector.test.ts`

**Interfaces:**
- Produces:
  - **thinking 折叠**:thinking_delta 累计进 partial.thinking(批次1 透传改折叠)
  - **user 消息对**:SDKUserMessage → `{kind:'message', phase:'start'→'end' 直发, turnId:null}`(user 消息不属 turn)
  - **流中止终值**(批次1 遗留):流终止无 result 时若 run 已开且未 end → 补发 `run.end{stopReason:'aborted', isError:false}`(旧路 run.cancelled 等价语义;与软中止的 result 路径互斥——有 result 走 result)
  - **领域新类**(按 T1 终表):plan.preview(SDK 流 plan 事件)/todo.state_updated/task.progress/advisor.reviewed 的 SDK 消息分支
- 测试:thinking 折叠累计/user 消息对/流中止补发(三种:中止有工具/无工具/已有 result 不重复)/领域新类各一

- [ ] Step 1-5: 先红后绿→SDK 全量→commit `✨ feat(sdk): projector 批次5——thinking 折叠/user 消息对/流中止终值/领域新类`

### Task 4: sidecar 第二入口(Phase A,按 T1 终表)

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`(handleAsyncEvent 扩 lsp 分支)
- Modify: coding.report 产生点(codingRunTracker 观察处,执行时定位)
- Test: 对应新测试文件(批次4 run.task-notification-bus.test 模式)

**Interfaces:**
- Produces: lsp.diagnostics 经 handleAsyncEvent 旁路注入(与 task_notification 同构);coding.report(若终表判迁)在其产生点双发

- [ ] Step 1-5: 先红后绿→sidecar 全量+typecheck→commit `✨ feat(sidecar): 批次5 第二入口(lsp/coding.report 按终表)`

### Task 5: web 适配器扩展+跳过清单(Phase A 收口)

**Files:**
- Modify: `apps/web/src/hooks/lifecycle-event-adapter.ts` / `useGlobalAgentListeners.ts`
- Test: `lifecycle-event-adapter.test.ts`

**Interfaces:**
- Produces: T2 全部新类 → 旧路等价 RuntimeEvent 映射(message.user.submitted/run.started/run.cancelled 三个此前"不产/让位"分支翻转为产;thinking_delta 映射);跳过清单扩至终表全量(旧路 live 对已迁类全跳);compaction 减配补齐(outcome←isError/trigger 真值);background.task 的 execution/resultRef(从 ToolEndDetail.meta 构造,批次2.1)
- **快照不注入机制不变**(新类无状态,天然幂等——memory/compaction 先例)

- [ ] Step 1-5: 先红后绿→web 全量→commit `✨ feat(web): 批次5 适配器全量+跳过清单收口`

### Task 6: runId 统一(Phase B)

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-loop.ts`(tee 参数)
- Modify: `packages/sdk/src/events/lifecycle-projector.ts`(删 randomUUID,runId 经参数)
- Test: 两包对应测试

**Interfaces:**
- Produces: `projectLifecycle(messages, options?: { runId?: string })`——lume-runner tee 处传 `observer.getRunId()`;全部骨架事件 runId=Lume runId;**验证**:闸门可收窄(memory live 拦截应解除——memory.context.used 到达时 runId 与已 flush assistant 同域,按 runId 判非重建)——**若收窄引入回归则保持闸门全量(记录),runId 统一本身仍交付**(双 divider 根治)

- [ ] Step 1-5: 先红后绿(id 断言)+双包全量→commit `♻️ refactor: runId 统一为 Lume runId(projector 弃自产 UUID)`

### Task 7: 删除与治理(Phase C,三个子任务)

**前置检查(硬性)**:T1 终表无"待定";T3-T6 全部合入;四包全量绿。

#### Task 7a: 删旧投影与跳过清单

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-observer.ts`(mapSdkMessageToRunItems 对已迁类分支删除——**注意**:裁定保留类(终表"裁")仍走旧路,只删已迁类分支)/`run-item-events.ts` 同理
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`(删 LEGACY_SKIPPED_PILOT_EVENT_TYPES 与跳过逻辑——已迁类旧路不再产,无需跳;**保留类分支原样**)
- Modify: hydrate replay(`runtime-event-history.ts`)——已迁类不再从 SDK log 投影(保留类照旧)
- Test: 各包全量(大量既有测试需按"旧路不再产已迁类"更新——**先跑基线拿到受影响清单再动手**,逐文件核对语义而非机械改断言)

- [ ] Step 1-5: commit `🔥 remove: 旧投影对已迁类的产生路径+web 跳过清单`

#### Task 7b: 白名单单源+归一收编

**Files:**
- Modify: `packages/shared/src/types/agent.ts`(AGENT_IPC_CHANNELS 加派生元数据或导出清单函数)
- Modify: `apps/desktop/src/renderer-sidecar-methods.ts`(PUBLIC_RENDERER_SIDECAR_METHODS 改由 shared 派生+本地增量)/`preload.ts`(ALLOWED_RENDERER_EVENT_CHANNELS 同理——注意 preload 是非 TS bundle,派生结果需构建期物化,选 typecheck 可验证的物化方式)
- Modify: status 归一三收一(从 shared 导出 normalizeTaskStatus,lume-runner/run-item-events/projector 统一引用)
- Test: 派生正确性(三处清单与 AGENT_IPC_CHANNELS 一致性断言)+归一单份断言

- [ ] Step 1-5: commit `♻️ refactor: 白名单单源派生+status 归一三收一`

#### Task 7c: 删 flag/闸门/打点/emit 收编/存储合并

**Files:**
- Modify: 删 `AGENT_LIFECYCLE_EVENTS` 全部读取点(sidecar run-loop/web vite envPrefix);删终态闸门+`[lifecycle-mismatch]`;emit 收编(RUNTIME_EVENT 的 web 通知产生点收敛——**按 T1 终表保留类的实际产生点评估**,能收编进统一 EventHub 出口的收,sidecar 内部消费保留);存储合并(events.jsonl 为唯一事件存储,旧 runtime-events store 的**保留类**数据迁入或双读过渡——按数据量与查询方定,执行时给方案入报告)
- Test: 全量回归+验收断言 1-5,8(grep 零命中)

- [ ] Step 1-5: commit `🔥 remove: flag/闸门/打点退役;emit 收编;存储单份化`

### Task 8: 终审与验收(8 条断言)

- [ ] Step 1: 验收 8 条逐一断言(spec §9.5):grep 三项零命中/emit ≤2/白名单结构/归一单份/**投影+UI 零改动 diff**(对照批次5 起点 main)/四包全量/五场景手动冒烟(流式/工具/压缩/记忆/后台任务)/存储单份
- [ ] Step 2: 整分支终审(opus)——删除批重点:保留类语义未损/无死代码残留/数据迁移完整
- [ ] Step 3: PR(base=main)

## 任务依赖

```
T1(先行,可立即) ──▶ 等栈合并 ──▶ T2 → T3 → T4 → T5 → T6 → T7a → T7b → T7c → T8
```

## 风险预案(spec §9.4)

任一类迁不动 → 终表降级"裁定保留+旧路最小切片",T7 范围收缩(记录);投影/UI 零改动若被突破 → 停下重审(双层模型是本批不可妥协项)。
