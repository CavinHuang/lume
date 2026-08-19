# Task 7c 报告:删 flag/闸门/打点/emit 收编/存储方案(Phase C 终段)

日期:2026-08-18 · 分支 `feat/agent-event-bus-batch5` · 前置:T7a(5456e97d)/T7b(8f7cbc6b)已入。

## 1. 删 flag:AGENT_LIFECYCLE_EVENTS 全部读取点(总线恒开)

| 读取点 | 处置 |
|---|---|
| `apps/sidecar/src/services/agent-runtime/runner/run-loop.ts` | 删 `isAgentLifecycleEventsEnabled()` 定义;`consumeRuntimeCoreQueryStream` 的 tee 接线(`lifecycle && flag` → `lifecycle`)+ `createObservedRuntimeEmitter` todo.state 分支(`bus && flag` → `bus`)恒开;interface 注释更新 |
| `apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts` | 删 import;`publishAdvisorReviewedToBus` 入口 flag 早退删除(恒 publish);`emitMemoryContextUsed` 的 `if (flag)` 包裹拆除(恒 publish) |
| `apps/sidecar/src/rpc/agent-handlers.ts` | 删 import;`ensureAgentEventsBridge` 的 `!flag ||` 前置条件删除(桥恒建) |
| `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts` | 删 import;三个 helper(`publishBackgroundTaskNotificationToBus`/`publishLspDiagnosticsToBus`/`publishCodingReportToBus`)的 flag 早退删除(恒 publish),doc 注释同步 |
| `apps/web/src/hooks/useGlobalAgentListeners.ts` | 删 `LIFECYCLE_BUS_ENABLED` 常量(vite env 读取);`lifecycleBusThreadId` 改恒取 active agent tab(总线消费恒开) |
| `apps/web/vite.config.ts` | `envPrefix` 的 `AGENT_` 条目保留(无害,已无消费者),注释更新说明退役 |

测试同步:7 个测试文件删 flag 设置/恢复 plumbing,删除 6 个 "flag off: 零行为" 测试(行为已不存在),保留测试去 env 依赖。其中 `lume-runner.memory-bus.test.ts` 的 "flag off" 测试在 T7a 后已是红(旧路 emit 已删但断言未同步,基线确认 fail),本批随 flag 一起清理,属修复而非放宽。

## 2. 删终态闸门+打点(含收窄选择)

`apps/web/src/components/agent/runtime-event-message-projection.ts`:

- 删 `TERMINAL_REBUILDING_EVENT_TYPES` 16 类集合(含整段甄别注释)。
- 删 `applyRuntimeEvent` 入口闸门 + `[lifecycle-mismatch]` console.debug 打点。

**收窄选择(T6 风险的最小防线,报告备案)**:

- 保留 `memory.context.used` 与 `advisor.reviewed` 两个分支内的 `if (state.terminalClosed && !state.currentAssistant) return` 早退。理由:这两个分支位于中段 `terminalClosed` 通用早退**之前**(它们须先于通用早退处理,因终态后合法到达的 usage/im/coding/compaction 等同类分支也在该区),历史 events.jsonl 双域回放与 hydrate replay 中这两类**仍可能终态后到达**(`??=` 重建同 id 空 assistant → React duplicate key,#22 教训),不守会复发。
- 其余 14 类(model.retry/assistant.*/tool.*/plan.preview/todo.state_updated/run 终值)不做显式防线:它们全部位于中段 `if (state.terminalClosed) return` 通用早退**之后**,该通用早退未被删除,继续兜底;原入口集合对它们是冗余覆盖。测试 `other rebuilding event types after a terminal run do not recreate the flushed assistant`(plan.preview 用例)在删集合后依旧通过,验证此点。
- 既有测试 `trailing memory context after early run close...`(CDP 实测双投序列)与 T6 同域收窄用例均通过,防线语义不变。

## 3. emit 收编(T7a 评审 Minor-2)

`apps/sidecar/src/services/agent/agent-notification-service.ts` `onError`:

- 合成 `run.failed`(`runtime-error:${threadId}`)改为仅在 `!isAgentRuntimeSessionActive(input.threadId)` 时发送——活跃 run 的失败终值由事件总线 `run.end{isError}` 单源交付(T7a 已迁),消除双投;无活跃 run 的 run 外失败(队列派发失败/规划启动失败等)保留兜底合成。
- `input.onError?.(error)` 回调(plan-mode phase 回退等)不受影响,恒调。
- 判定成本低(单 Map 查找 `activePiSessions`,调用处本就持有 threadId),按方案执行;无循环依赖(attempt.ts 不反向依赖本模块)。
- 未加单测:active 分支依赖 attempt.ts 全局会话注册表,单测需拉起真实 runtime session 机制,成本高于收益;现测试覆盖 inactive 路径(合成照发)。

## 4. 存储方案(只定不迁,数据迁移单独批次)

**现状双源盘点**:

- 源 A「保留类历史」:`listThreadRuntimeEvents`(runtime-event-history.ts)= run-state store(`projectRunStateToRuntimeEvents`:run.started/message.user.submitted/run 终值 + 保留类 items)+ task store(task.progress)+ SDK log(memory_saved → memory.changed)。经 `GET_THREAD_RUNTIME_EVENTS` 消费:web `AgentMessages` 首开线程 hydrate + `MESSAGE_APPENDED` 刷新。sequence 为每 run 自增,与总线 seq 无关。
- 源 B「总线全量」:events.jsonl(ThreadEventBus 落盘,线程级单调 seq)。消费方:`GET_EVENTS`(web `useAgentEventBus` 快照/空洞补拉)+ `agent:events` 桥(实时推 active tab)。**重开线程时快照回放不注入事件**(consumeBusEnvelope 注释:旧路 hydrate 已覆盖,双份注入无法去重)。

**T8 后合并方案(推荐:双读过渡 → 保留类历史到期清理)**:

1. **双读过渡(第一步,可独立交付)**:重开线程时在源 A hydrate 之外,把 events.jsonl 快照(GET_EVENTS 全量)经适配器 snapshot 通道注入——`consumeBusEnvelope` 已具备 seq 水位 + id 去重(`mergeHydratedRuntimeEvents` seenIds),改动集中在 snapshot 不注入的开关语义。收益:已迁类重开线程后有完整历史(当前 live-only)。
2. **保留类到期清理(终态)**:保留类(message.user.submitted/task.progress/usage.updated/model.retry 系/plan.preview/memory.changed 系等)逐类迁总线后,源 A 三条投影链(run-item-events/task store/SDK log memory_saved)整链退役,`GET_THREAD_RUNTIME_EVENTS` 通道下线,events.jsonl 成为唯一事件存储。
3. **不做历史回填**:把旧线程的保留类历史迁入 events.jsonl 数据量大、收益低(旧线程渲染另有持久化消息源 `getThreadMessages` 兜底);自然形成"旧线程源 A 读、新事件源 B 写"的分界,无需迁移脚本。

## 5. 验证

- 定向测试:sidecar 7 个触碰文件 22 pass;web projection 50 pass;web `src/hooks`+`src/components/agent` 452 pass / 29 fail——**29 fail 与 stash 基线完全一致**(既有红:RuntimeEvent UI boundary 源码扫描系 + ImageGen/Wiki 组件系,与本改动无关)。sidecar `src/services/agent-runtime` 全目录测试后台运行中(超 10min,目录全量本就慢;触碰文件已定向绿)。
- typecheck:六包(shared/ui/agent-sdk/sidecar/web/desktop)全绿。
- grep 断言:源码(非测试非文档)`AGENT_LIFECYCLE_EVENTS`/`isAgentLifecycleEventsEnabled`/`LIFECYCLE_BUS_ENABLED` 零命中(仅剩 2 处退役说明注释);`TERMINAL_REBUILDING_EVENT_TYPES`/`lifecycle-mismatch` 零命中(仅剩 2 处退役注释);测试文件 flag 引用零命中。

## 6. Follow-ups

- 存储双读过渡(4.1)与保留类清理(4.2)为独立批次,按 T1 终表保留类迁移节奏推进。
- `[lifecycle-mismatch]` 打点退役后,时序错位观测能力消失;若后续再现 duplicate key 类问题,靠 #22 防线的行为测试(已存在)定位。

## Fix round 1(评审 Major-1 + Minor-1/2)

**Major-1(emit 收编时序失效)**:初版判定 `!isAgentRuntimeSessionActive(threadId)` 在 run 内失败主路径恒 true——session 于 `lume-runner` finally 的 `unregisterAbort` 注销后才走到 `emit.onError`(`attempt.ts` 对 errored 结果的二次 onError 也在注销后),判定恒 false → 合成照发,双投未消除,且合成先到时 UI 显示 runtime-error 空 failed。

**采用的判定信号**:`AgentStreamEmitter.onError` 加可选第二参 `options?: { fromActiveRun?: boolean }`——错误是否来自 run 执行链由**调用位置自身**表达,不依赖任何可变运行时状态查询:

- `agent-service.ts` 内层 onError(`runAgentRuntime` 的 emit,唯一 run 内失败转发点,覆盖 lume-runner.fail 与 attempt errored 二次转发两条路径)→ `emit.onError(error, { fromActiveRun: true })`
- run 外失败(kernel `onDispatchError` 派发失败、sendAgentMessage 缺渠道/模型启动分支、planning/automation/memory-v2 后台自建 emitter)不经内层,缺省无标记 → 合成兜底照发
- `trackedEmit`(submission 跟踪层)透传 options
- notification emitter 合成闸门:`options?.fromActiveRun !== true` 才合成;`input.onError?.(error)` 回调不受闸门影响

**否决的备选**:① status manager streaming 态——`markStreaming`(agent-service:1006)先于缺模型启动失败分支执行,且内层 onError 先 `markErrored` 再转发,run 内/外两场景在判定点读到的 phase 同为 errored,不可区分;② attempt 层查"该 run 是否发过总线 run.end"——attempt 不持有 bus 引用,需跨层传递,侵入更大。调用位置标记是唯一零歧义信号。

**Minor-1**:agent-notification-service.test 补 onError 两用例(run 外缺省 → 合成发出且外层回调仍调;fromActiveRun → 不合成且回调仍调)。另加 agent-service 集成验收两用例:mock "failed-run" 路径(run 内失败)断言零 `runtime-error:` 合成;无渠道线程 sendAgentMessage(启动失败)断言恰好 1 条合成。

**Minor-2**:lume-runner.ts runQueryStream 处过时 flag 注释删除。

**验证**:notification-service 3 pass/0 fail;agent-service 29 pass/1 fail(既有红同名"后台任务通知仍应单独持久化",与本改动无关);sidecar typecheck 绿。
