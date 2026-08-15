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
- turn 落定改由 turn.end 驱动(assistant 消息逐 turn 进列表,不等 run 完成)——P4 兑现

atom 写入保留 rAF 批量;旧 useGlobalAgentListeners 对试点链事件分支停用(flag 同步),其余链路照常。

### 4.5 feature flag

`AGENT_LIFECYCLE_EVENTS`(配置,生成与消费两端同 flag):关 = 完全旧路(回滚开关);开 = 试点链新总线。批次5 迁移完成后删 flag 与旧路。

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| 推送失败/无订阅者 | 不重试;事件已持久化,重连 get-events 补齐 |
| web 收到 seq 空洞(存储损坏等) | 全量重拉(从 0 回放) |
| push/pull 交叠(重连窗口) | web 按 seq 去重归并 |
| 流式中途 error/abort | projector 兜底:补发 message.end(error)+ turn.end(空)+ run.end(aborted) |
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
| 3 | 交互领域事件(权限/ask_user/browser_auth/desktop_action) | 请求-应答闭环上新总线;pending 持久化沿用 |
| 4 | 系统类(init/api_retry/compaction×3/task_notification/status…) | kind+phase='event' 直迁 |
| 5 | 收尾 | 删旧投影双开关盒、合并 events.jsonl 与 runtime-events store、删 flag、官方兼容出口终态确认 |

## 8. 风险

- 双存储并存期磁盘双写、一致性各自独立(批次5 合并,查询互不跨界)
- 高频流式打 IPC → 16ms 微批(试点必做)
- web 双路径并存由 flag 保证同链路单路径,UI 组件逐个切
- 终态(engine 产新形态反转)不在本 spec,批次5 评估

## 附录:与 pi 事件流的对照(设计依据)

| 维度 | pi | Lume 现状 | 本设计 |
|---|---|---|---|
| 形态 | 生命周期四级嵌套,事件自包含 | 33 成员扁平 union | 信封+四级骨架,自包含(turn.end 带 toolResults) |
| 流式 | message 三段式 | stream_event+assistant 两类事件 | 三段式,message.update 带累计 partial(pi 同款消费者友好) |
| 背压 | 每事件 await listener | generator 拉取 | 拉取+推送加速,持久化兜底 |
| 持久化 | message_end 同步 append(事件序=落盘序) | run 完成版本化 + SDK 节流落盘(两套) | 事件流 append-only 单序(seq);消息持久化另行收敛(批次5) |
| 词汇主权 | harness 即协议 | SDK 协议钉死官方 + sidecar 翻译层 | shared 单源词汇表,翻译层迁移终点删除 |
