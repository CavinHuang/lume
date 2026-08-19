# Agent 事件总线设计(Lifecycle Event Bus)· 批次1:试点链

- 日期:2026-08-15
- 状态:待审阅
- 范围:`packages/shared`(事件类型单源)、`packages/sdk`(LifecycleProjector)、`apps/sidecar`(ThreadEventBus + IPC)、`apps/web`(useAgentEventBus + 试点链 UI)
- 背景:pi 事件流对照分析(2026-08-14)与 Lume 四层事件管线取证;关联分支 PR#82(中断可恢复阶段1,建议先合并)

## 1. 问题:现有事件流的八个痛点

| # | 痛点 | 证据 |
|---|---|---|
| P1 | 双词汇表+翻译层:SDKMessage(官方协议钉死)与 RuntimeEvent 并存,新事件要过 mapSdkMessageToRunItems + projectRunItemToRuntimeEvents 两个开关盒 | run-observer.ts:225-319 |
| P2 | 三个消息副本:SDK sessionMessages / AgentThreadMessage / RuntimeEvent 流,投影维持一致——阶段1 的 C1(重复 tool_result)即此接缝缺陷 | agent-service.ts:1141-1172 |
| P3 | 无 turn/run 边界事件,UI 靠数消息、sidecar 重新组装聚合 | 对照 pi turn_end 自携带 toolResults |
| P4 | assistant 消息 run 完成才落定推送,多 turn run 中间输出滞后 | agent-service.ts:1141 |
| P5 | 通知驱动重拉:MESSAGE_APPENDED 到达后 web 重拉 3 个接口 | useGlobalAgentListeners.ts:280-303 |
| P6 | 流式(stream_event)与终值(assistant)是两类事件,非生命周期三段式 | engine.ts:1176/1336 |
| P7 | onAsyncEvent 旁路队列循环边界排空,与主流存在乱序窗口;IPC 无全局序号 | agent.ts:1050/1093 |
| P8 | 33 成员扁平 union,无版本化信封,演进靠加成员 | types.ts:58-92 |

## 2. 已确认决策

| 维度 | 决策 |
|---|---|
| 演进策略 | 新总线与旧路并行,逐事件类型迁移,终点删旧路(不搞大爆炸切换) |
| 词汇表主权 | SDK 层:新词汇从 SDK 定义(终态,批次5 反转 engine 内部产出);官方 Claude Agent SDK 兼容形态在迁移期仍是 engine 的规范产出、批次1 由它投影出新事件(旧→新),终态降级为派生视图;sidecar 投影层(双开关盒)在迁移终点删除 |
| 事件模型形态 | 信封 + 四级生命周期骨架(run/turn/message/tool 各有 start/update/end)+ 领域负载挂 detail |
| 投递保证 | 快照 + seq 增量续传:持久化即承诺、推送只是加速 |
| 实施切分 | 垂直切片试点:assistant 流式→落定链端到端打通(P4+P6),验证后按模板逐批迁移 |
| engine 改造 | **零改动**:engine 继续产 SDKMessage(官方形态为规范源),新事件为纯函数投影(旧→新);终态再评估是否反转 |

## 3. 事件模型

### 3.1 信封(Envelope)

```ts
// packages/shared/src/types/agent-events.ts(新,三方共用单源)
interface SdkEventEnvelope<T = unknown> {
  v: 1                        // schema 版本;消费者见未知版本按容忍策略处理
  seq: number                 // 线程内单调递增,快照/续传/去重锚;sidecar 落盘时分配
  threadId: string
  runId: string
  turnId: string | null       // 骨架定位;run 级事件为 null
  ts: number
  kind: 'run' | 'turn' | 'message' | 'tool'
  phase: 'start' | 'update' | 'end' | 'event'
  detail: T                   // 类型化负载,由 kind+phase(+detail.type)决定
}
```

**seq 分配权在 sidecar 的 ThreadEventBus**(单写者):engine 是纯生成器、可多实例并发(子 agent),不具备线程唯一序号分配权;sidecar 是线程事件流唯一汇点,持久化+分配一体。

### 3.2 四级生命周期骨架(语义全集;批次1 只实现前三级 + assistant message)

```
run    : run.start → … → run.end(detail: usage/cost/numTurns/stopReason/is_error/中断标记)
turn   : turn.start → … → turn.end(detail: { assistantMessage, toolResults[] } 自包含)
message: message.start → message.update×N → message.end
         (assistant 流式三段式;user/toolResult 消息对为 start→end 直发)
tool   : tool.start → tool.update×N → tool.end(detail: result/isError)   [批次2]
领域事件: kind+phase='event',detail.type 区分(权限/压缩/api_retry/…)   [批次3-4]
```

## 4. 批次1 组件设计

### 4.1 LifecycleProjector(SDK,纯函数状态机)

`packages/sdk/src/events/lifecycle-projector.ts`:

```
输入:SDKMessage 流(engine 现有 yield,零改动)
输出:SdkLifecycleEvent 流(kind/phase/detail/turnId/ts;无 seq——sidecar 盖信封)
```

状态机规则:
- run 边界:流首(跳过 init/system 类)→ `run.start`;旧 result 事件 → `run.end`(detail 迁移 usage/cost/num_turns/stop_reason/is_error)
- turn 边界:每条 assistant(终值)→ turnId = 稳定兜底 id `turn-<run 内序号>`(join key 全程不可变;assistant uuid 只进 detail.assistantMessage,不作 turnId);`turn.start` 在其首条 stream_event 到达时发出;`turn.end` 当该 assistant 全部 tool_use 收到对应 tool_result 后发出(id 命中优先 + 数量兜底 + 孤儿忽略的混合配对;detail 自携带 assistantMessage + toolResults[]);无 tool_use 的 assistant:turn.end 紧随 message.end
- message 三段式:首条 stream_event → `message.start`(空壳);每条 stream_event → `message.update`(detail:原生 delta + 折叠后累计 partial,消费者免攒状态;thinking_delta 批次1 只透传不折叠,partial.thinking 字段留批次2);assistant 终值 → `message.end`(完整消息)
- **无流式退化**(includePartialMessages=false,无 stream_event):`turn.start`+`message.start`+`message.end` 由 assistant 终值触发改良直发(单消息内三连发,保持骨架完整性);update 段缺省
- 兜底:流式中途 error/abort → `message.end`(带 error)+ `turn.end`(toolResults=[])+ `run.end`(stopReason=aborted)——与阶段1 软 abort 语义对齐;冷启动 toolContinuation 恢复的 tool_result 归入当前 turn
- 导出:`projectLifecycle(messages: AsyncIterable<SDKMessage>): AsyncGenerator<SdkLifecycleEvent>`(组合式,agent.query() 返回值可直接 pipe)

### 4.2 ThreadEventBus(sidecar,新组件)

```
projector 产物 → ThreadEventBus(每线程单实例 = seq 单写者)
  ├─ 盖信封(分配 seq,落盘成功即定序)
  ├─ 追加持久化:thread 目录 events.jsonl(append-only,与 seq 同序;
  │   不动现有 runtime-events store——它继续服务未迁移链路,批次5 合并)
  └─ 推送:IPC 通道 agent:events → 订阅该线程的全部 web 端
```

- 投递语义:推送失败/无订阅不重试不阻塞——**持久化即承诺,推送只是加速**
- 崩溃窗口:yield 后、落盘前崩溃则丢(尽力而为,与阶段1 节流持久化一致);assistant 终值另有 session 持久化兜底
- **推送侧微批(必做)**:16ms 窗口 coalesce 同 kind+phase 的 update,payload 为折叠后 partial——高频 delta 不打爆 IPC,且 detail 自带累计 partial 天然支持 coalesce
- 试点边界:仅主线程 run;子 agent 事件不进总线(subagent_run_id 非空跳过,批次2 决定归属)

### 4.3 IPC(shared + sidecar)

- 推送通道:`AGENT_IPC_CHANNELS.EVENTS = 'agent:events'`(通知,新增)
- 查询通道:`AGENT_IPC_CHANNELS.GET_EVENTS = 'agent:get-events'`(请求,新增):入参 `{ threadId, afterSeq?: number }`,返回 `seq > afterSeq` 的全部事件;afterSeq 缺省从 0 回放

### 4.4 web 消费(新 hook `useAgentEventBus`)

```
挂载/线程切换/断线恢复 → getAgentEvents({ threadId, afterSeq: 本地最大 seq })
  ├─ 纯增量拉取;首次(无 afterSeq)= 全量回放 = 事实快照
  │    # ponytail: 大线程可加周期检查点,回放变慢前不动
  └─ 同时订阅 agent:events(push);按 seq 去重排序归并
       (重连窗口 push/pull 交叠 → 小缓冲归并;seq 空洞 → 全量重拉)
```

试点链 UI 两处改造:
- 流式渲染改由 message.start/update/end 驱动(取代 stream_event 直连)
- turn 落定改由 turn.end 驱动(assistant 消息逐 turn 进列表,不等 run 完成)——P4 兑现。**批次1 实现偏差**:turn.end 不产 UI 事件,落定由 message.end→assistant.final 覆盖(管线等价,plan P4 修正已论证),逐 turn 进列表待批次2

atom 写入保留 rAF 批量;旧 useGlobalAgentListeners 对试点链事件分支停用(flag 同步),其余链路照常。

### 4.5 feature flag

`AGENT_LIFECYCLE_EVENTS`(配置,生成与消费两端同 flag):关 = 完全旧路(回滚开关);开 = 试点链新总线。批次5 迁移完成后删 flag 与旧路。

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| 推送失败/无订阅者 | 不重试;事件已持久化,重连 get-events 补齐 |
| web 收到 seq 空洞(存储损坏等) | 全量重拉(从 0 回放) |
| push/pull 交叠(重连窗口) | web 按 seq 去重归并 |
| 流式中途 error/abort | **批次1 实现偏差**:流终止无 result 终值时 projector 不补发任何事件(含 run.end),终值语义由旧 result 路径兜底;`message.end(error)+ turn.end(空)+ run.end(aborted)` 补发链留批次2 |
| 半行尾(append 断电) | 读取侧容忍并截断到最后一完整行 |
| fork 线程 | seq 从 0 重开,事件流不继承历史(声明的语义) |
| flag off | 全量走旧路,零行为变化 |

## 6. 测试策略(bun:test)

1. **Projector 状态机**:单 turn 带工具 / 多 turn / 无工具 assistant / 流式 error / 软 abort / 冷启动 continuation / turn.end 聚合正确性(配对齐才发、自携带完整 toolResults)
2. **ThreadEventBus**:seq 单调无空洞 / append 原子性(半行容忍) / 多订阅广播 / 崩溃重启续传 / 16ms 微批折叠
3. **get-events**:afterSeq 纯增量 / 首次全量回放 / afterSeq 越界
4. **useAgentEventBus**:快照+push 归并去重 / 空洞全量重拉 / 线程切换清理
5. **端到端(试点链)**:turn 落定延迟对比(turn.end 即可见 vs 旧 run 完成后) / 断线重连一致 / flag off 全量回归零变化

## 7. 迁移路线图(每批次一个 PR,照批次1 模板)

| 批次 | 内容 | 关键点 |
|---|---|---|
| 1(本 spec) | run + turn + assistant message | 全链路验证与模板 |
| 2 | tool 三段式 | 吞并 tool_result/tool_use_summary/tool_progress;子 agent 归属决策;权限拦截点挂 tool.start 前 |
| 3(已完成,范围收窄) | memory.context.used 迁移(第二注入路径:数据源在 session 层而非 SDK 流,lume-runner 在旧发点同步 bus.publish,runId 用 Lume runId 修正批次1 projector 自产 UUID 错位)。**终审实证(2026-08-16)**:memory 事件 seq 恒在 run.end 之后(lume-runner 在流返回后才双发),live 总线版被终态闸门**确定性拦截**(`[lifecycle-mismatch]` 每 memory run 必触发)——live 展示实际由旧路 hydrate replay 驱动,总线事件为 events.jsonl 落盘先占;根因是 projector UUID 与 Lume runId 分裂(闸门无法 runId 域化收窄),**批次5 统一 runId 并删旧路后由总线接管**。验收表述修正:本类打点不归零,批次5 才归零 | **范围收窄裁决**:交互事件(权限/ask_user/browser_auth/desktop_action)不迁——专用请求-应答闭环通道单源无双投,迁移需重建闭环无收益(原批次3 主题,修正);memory.changed/memory.job.* 不迁——版本计数非渲染路径,YAGNI;memory.context.used 迁移——批次1 `[lifecycle-mismatch]` 打点错位实锤。**消费端裁定转正**(批次2 遗留两项):① error assistant 悬空卡:总线不发未执行工具的 tool.start 为正式语义(旧路悬空卡为缺陷,批次5 删旧路后全库一致);② 孤立 tool_result:不产 tool.end(无 start 的 end 无意义;count-fallback 补位例外为有意容忍),终态闸门与 orphan guard 为正式语义 |
| 4(已完成,范围实证收窄) | task_notification(非 subagent)+ compaction×3 迁移。**双入口注入**(engine 二选一):in-run 走主流 projector 投影、late 走 onAsyncEvent 旁路(run.ts handleAsyncEvent 直发 bus)——P7 旁路乱序被 seq 单调收编;late 双投(agent-service projectLate 双发)的 **live 同 id 双投**随跳过清单消除(hydrate replay 异 id 共存为已知过渡形态,批次5 删 runtime-event-history 旧投影根治)。**已知减配(终审 M-1)**:flag on 时 compaction 因 runId 分裂(总线 projector UUID vs 旧路 Lume runId)渲染**双 divider**——批次5 runId 统一根治。**范围裁决(取证依据)**:api_retry 不迁(live-only 单源无双投;迁入会引入回放突现新面——批次3 教训);memory_saved 不迁(批次3 同构,流外补发被闸门拦;consolidation 突现留旧路内修);init/status 不迁(零消费方)。subagent 形态不迁(独立闭环 SUBAGENT_COMPLETED) | kind+phase='event' 直迁(原案,已被实证收窄取代) |
| 5 | 收尾 | 删旧投影双开关盒、合并 events.jsonl 与 runtime-events store、删 flag、官方兼容出口终态确认;**runId 统一**(批次3 记入:根治闸门 runId 域化收窄与 memory live 拦截;**批次4 M-1:compaction 双 divider 的直接根因**);**late 通知 idle 错置新 run streaming 加 run 活跃判断**(Info-2)。**批次4 评审并入清单**:①adapter 补 outcome←detail.isError、summary/failureReason←detail.result(否则失败压缩渲染成成功文案);②骨架带 trigger 真值(否则手动 /compact 显示"自动");③compaction 置 streaming 副作用迁移(交叉时序瞬态 idle 窗口);④status 四态归一三份复制收编一份;⑤contextWindow/budget 骨架透传(消费降级点);⑥memory.context_used claim 类型 string→MemoryClaim 对象(批次3 F2) |

## 8. 风险

- 双存储并存期磁盘双写、一致性各自独立(批次5 合并,查询互不跨界)
- 高频流式打 IPC → 16ms 微批(试点必做)
- web 双路径并存由 flag 保证同链路单路径,UI 组件逐个切
- 终态(engine 产新形态反转)不在本 spec,批次5 评估

## 9. 批次5 终局设计(三阶段收敛,2026-08-17 定案)

**决策**:范围=原 8 项+散落治理合并一次收敛;投影终态=**双层模型+单点适配**(视图模型正当化,不消除)。

### 9.1 三阶段结构与核心依赖

```
Phase A 定案:A 表 14 类留旧路事件逐一取证 → 迁(~10)或正式裁定死(~4)
             —— 判据同批次4:无双投/乱序/回放突现面 → 裁;有 → 迁
Phase B 统一:runId 统一(Lume runId 贯穿,projector 经 tee 参数拿真 id)
             + 减配补齐(compaction outcome/trigger/streaming、tool meta、
               thinking 折叠、contextWindow/budget、claim 类型)
Phase C 删除与治理:删旧投影双开关盒/双存储之一/flag/终态闸门/打点/跳过清单;
             治理:白名单单源(AGENT_IPC_CHANNELS 派生三处)/status 归一三收一/
             emit 产生点收编(EventHub 单出口)/适配器单文件化
```

**核心依赖**:删旧路的前置是 A 表全部定案(迁完或裁定死)——不允许"删一半"。

### 9.2 双层模型终态

```
传输模型:agent-events.ts(SdkEventEnvelope+detail)——唯一线上形态,seq 单调
视图模型:runtime-event.ts(36 类)——投影/UI 稳定消费,Phase C 后不再新增
单点适配:lifecycle-event-adapter——唯一翻译点(收编其余散落 switch)
```

### 9.3 A 表 14 类终表(2026-08-17 T1 取证定案)

迁:message.user.submitted(骨架 user 消息对)/run.started(补映射)/run.cancelled(需 projector 补流中止终值,批次1 遗留)/assistant.thinking_delta(需 partial.thinking)/plan.preview/todo.state_updated/task.progress/advisor.reviewed/lsp.diagnostics.updated(task_notification 双入口模式)/coding.report.updated(产生点双发,与 lsp 同构第二入口)
- **coding.report.updated → 迁**:与 run.completed 双路携带同 report(run.ts:1852/1914 in-run+late vs run-item-events.ts:80/98 终态全量,双投面)+ late 后台任务终态后到达(乱序面),批次4 late 旁路 seq 单调可承载;runId 统一后消除投影 `assistant:${runId}` 前缀匹配错位(批次1 finalMessageId 关联遗留)

裁(正式裁定,旧路保留,T7a 分支原样):
- **usage.updated → 裁**:live/replay 同源同 id(run-item-events.ts:537-553 派生,web id 去重收敛)、单相、消费全幂等覆盖,三面皆无
- **im.delivery → 裁**:live-only 单源(im-message-router.ts:251 唯一产生点,合成 runId 非线程 run 域),迁入反而新增过期投递状态重放突现面(api_retry 同构)
- **guidance.delivered → 裁**:web 零消费方 + canUseTool 闭环单源(attempt.ts:238),迁移零收益(闭环语义由 deny 工具消息承载)
- **desktop.action_visual → 裁**:瞬态 overlay live-only(computer-use emitVisual,1600ms 自焚),迁入即 overlay 重放突现;专用原子消费不经消息投影

(取证报告:`.superpowers/sdd/2026-08-17-agent-event-bus-batch5/t1-research.md`;判据 §9.1,边界倾向裁)

### 9.4 任务分解(8 任务)

T1 取证定案(五类代码取证→终表入 spec)/T2 类型扩展/T3 projector(thinking 折叠+user 对+aborted 终值+领域新类)/T4 sidecar 第二入口/T5 web 适配+跳过清单/T6 runId 统一/T7 删除与治理/T8 终审验收。

**风险预案**:任一类迁不动 → 降级"裁定保留+旧路最小切片保留",T7 范围收缩(记录)。

### 9.5 验收(8 条可断言)

1. flag 与旧投影双开关盒 grep 零命中;2. 闸门+打点代码零命中;3. RUNTIME_EVENT emit 点 ≤2;4. 白名单三处手写→单源派生;5. status 归一全仓一份;6. **投影与 UI 零改动**(diff 断言);7. 四包全量绿+五场景冒烟;8. events.jsonl 唯一事件存储。

### 9.6 执行前置

#93→#94→#95→#97 依次合并后,基于新 main 开分支执行(删除批不可栈式)。

## 附录:与 pi 事件流的对照(设计依据)

| 维度 | pi | Lume 现状 | 本设计 |
|---|---|---|---|
| 形态 | 生命周期四级嵌套,事件自包含 | 33 成员扁平 union | 信封+四级骨架,自包含(turn.end 带 toolResults) |
| 流式 | message 三段式 | stream_event+assistant 两类事件 | 三段式,message.update 带累计 partial(pi 同款消费者友好) |
| 背压 | 每事件 await listener | generator 拉取 | 拉取+推送加速,持久化兜底 |
| 持久化 | message_end 同步 append(事件序=落盘序) | run 完成版本化 + SDK 节流落盘(两套) | 事件流 append-only 单序(seq);消息持久化另行收敛(批次5) |
| 词汇主权 | harness 即协议 | SDK 协议钉死官方 + sidecar 翻译层 | shared 单源词汇表,翻译层迁移终点删除 |
