# Agent 中断可恢复(Interrupt-Recoverable)设计

- 日期:2026-08-14
- 状态:待审阅
- 范围:`packages/sdk`(engine / agent / session / types)+ desktop 恢复提示入口
- 参考:pi(`D:\workspace\projects\ai-projects\pi`)中断/恢复语义取证结论(见附录)

## 1. 背景与问题

Lume agent 的中断与恢复现状:

1. **中断是硬 abort**:`Agent.interrupt()`(`agent.ts:1219`)直接 `abortCtrl.abort('interrupt')`,进行中的工具执行被砍,已完成但未持久化的进度丢失。
2. **持久化是 run 级**:`runSinglePrompt` 的 `finally` 块(`agent.ts:1097-1108`)在整个 run 结束后才写盘。run 中途崩溃,该 run 的全部进度(assistant 消息、工具结果)丢失。
3. **引擎已有冷启动续跑地基,且已有宿主调用方**:`QueryEngine` 支持 `toolContinuation`(`engine.ts:993-1035`)——从持久化的工具边界精确恢复:有 `toolResult` 则注入不重跑(幂等),无则重跑一次。已有两个测试覆盖(`engine.test.ts:120/170`)。
4. **sidecar 已建成"审批/交互中断"恢复体系**(2026-08-14 取证,这限定了本设计的增量边界):
   - 捕获:approval-service / ask-user-service 在暂停时写 `RunContinuationState`(V2 checkpoint:`step`/`toolCall`/`inputHash`/`kind`/`syntheticToolResult`,`run-continuation.ts:34`)
   - 恢复:desktop 已有 `agent:resume-run` IPC → `LumeResumeService.resumeRun`(`resume-service.ts:30`)决策树:read 工具结果未知 → 允许相同输入安全重放;**execute 副作用工具结果未知 → 禁止重放(not_resumable)**;后台任务(processJobId)→ 重新附着不重跑
   - 冷启动续跑:`buildColdStartContinuationMessage` + `runtimeContinuation` metadata → `run.ts:2256` 解析 → SDK `toolContinuation` 精确恢复

**已有体系的覆盖缺口 = 本设计的增量**:checkpoint 只在审批/ask_user 暂停时写入。用户主动停止(硬 abort)与进程崩溃时:无 checkpoint、session transcript 仍是 run 级 finally 持久化(整 run 进度丢失)、`executeTools` 在 abort 后丢弃已完成批次结果(`engine.ts:1585/1592/1605/1607` 抛 Error)→ 留下悬空 tool_use。

结论:复用 sidecar 体系补 abort/崩溃场景,不另建平行体系。

## 2. 目标与非目标

### 目标(阶段1,本 spec 详设)

- 中断(用户停止 / 进程崩溃)不丢失已完成的工具结果与 assistant 消息
- message 级增量持久化(对齐 pi 粒度)
- 重启后检测"未完成 run",提示用户确认后从断点冷启动续跑
- 修复"悬空 tool_use"(assistant 带 tool_use 但缺 tool_result 的崩溃残局)——pi 未解决的缺陷
- 用户主动中断后 session 落在干净状态(补 error tool_result),不需要恢复流程

### 非目标(阶段2,仅概述)

- 原地暂停/续跑(不重启进程、不冷启动)的状态机
- steering / followUp 队列(方面1/2,另行设计)
- 非末尾历史损坏的修复

## 3. 关键设计决策(已确认)

| 维度 | 决策 | 依据 |
|---|---|---|
| 总路线 | 复用 sidecar RunContinuationState / resume-run 体系,补 abort/崩溃缺口 | 已有体系覆盖审批中断,避免两套恢复语义并存 |
| 场景 | 崩溃恢复 + 软中断,分阶段落地 | 用户确认 |
| 恢复触发 | 提示恢复:重启后提示"是否继续",用户确认才续跑 | 副作用工具重跑需人工兜底 |
| 持久化粒度 | message 级(每条 assistant/tool_result 落盘) | 对齐 pi(`message_end` → append) |
| abort 语义 | 软中断:已开始工具完成并保留结果,批次边界停止 | 对齐 pi |
| 副作用重放 | 对齐 sidecar 保守语义:execute 型结果未知禁止重放,注入中断说明让模型读实际状态 | 与审批中断恢复一致 |
| 悬空 tool_use | 无 checkpoint 时的崩溃兜底,用 `toolContinuation` 修复 | 补 pi 缺陷 |
| 写盘机制 | 节流全量重写(200ms),不改 append-only | `saveSession` 全量写,load 路径改动最小 |

## 4. 阶段1 架构

```
  run 启动
     │
     ▼  (每条 assistant / tool_result message 产生时)
  message 级节流持久化(leading 立即 + trailing 200ms 合并)── SDK 层
     │
     ├─ 审批/ask_user 暂停 ──▶ 现有 checkpoint 体系(不动)
     │
     ├─ 主动中断(软 abort)
     │     ├─ SDK 收尾:已完成工具结果保留 + 未完成 tool_use 补 error tool_result ──▶ session 干净
     │     └─ SDK 发 abort 断点事件 ──▶ sidecar 写 RunContinuationState(status: interrupted)
     │
     ├─ 正常完成 ──▶ finally 兜底 flush + run 终态落盘
     │
     └─ 崩溃 ──▶ 已落盘 message 保留;checkpoint 取决于最后观察事件
                    │
                    ▼  (进程重启)
        sidecar 枚举线程最后 run:runStateStore 终态 + continuation 状态
                    ▼
        desktop 提示"上次有未完成任务,是否继续?"
                    │ (用户确认)
                    ▼
        有 checkpoint ──▶ 现有 LumeResumeService 决策树(execute 未知→禁止重放)
        无 checkpoint ──▶ 悬空兜底:detectDanglingToolUses(history)
                          ├─ read 型 → toolContinuations[] 重放
                          └─ execute 型 → 注入中断说明(不重放)
                          ──▶ submitMessage('', { toolContinuations }) 续跑
                    ┼ (用户拒绝)
                    ▼
        清理:补 error tool_result 清理悬空 ──▶ 回到可用状态
```

### 4.1 message 级持久化

`runSinglePrompt` 的 for-await 循环中,每次 push sessionMessage 后调度节流持久化:

- 首条立即写(leading),200ms 窗口内后续合并为一次尾随写(trailing)
- run 结束 `finally` 保留现有 `persistCurrentSession` 作为兜底 flush(现有行为不变)
- 持久化失败:吞掉 + console.warn,run 继续;兜底写失败维持现有错误传播

```
# ponytail: 全量重写+节流,大 session(数 MB)写放大若成瓶颈,升级为 JSONL append-only
```

### 4.2 abort 断点捕获(复用 RunContinuationState)

不新建 activeRun 标记——"未完成 run"由现有 `runStateStore` 终态 + `RunContinuationState` 推断:

- SDK 层新增 abort 断点观察事件:engine 软 abort 收尾时,通过现有 `onAsyncEvent` 回调发出 `{ type: 'run_aborted', pendingToolCalls: [...] }`(含未完成工具的 id/name/input/kind 分类)
- sidecar 的 `runtime-core/run.ts`(已订阅 `onAsyncEvent`)接收该事件 → 用与 approval-service 相同的写入器落 `RunContinuationState { status: 'interrupted', checkpoint: { step: 'waiting_for_tool_result', toolCall, toolKind } }`
- 正常完成的 run 终态已由现有 runStateStore 记录,无需额外标记

### 4.3 悬空 tool_use 检测(纯函数)

新模块 `packages/sdk/src/interrupt-recovery.ts`:

```ts
detectDanglingToolUses(messages: NormalizedMessageParam[]): DanglingToolUse[]
```

- 扫描**最后一条**含 tool_use 的 assistant message,返回其中没有对应 tool_result 的 tool_use blocks
- 只处理末尾:中断只可能发生在末尾;更早的悬空属于历史损坏,阶段1 不修(见错误处理)

### 4.4 `PersistedToolContinuation` 扩为数组

当前单数结构表达不了"一轮 N 个工具中断在第 k 个"(N-k+1 个悬空):

```ts
// types.ts
toolContinuations?: PersistedToolContinuation[]
// 保留单数类型 PersistedToolContinuation 作为元素类型;旧单数字段迁移为数组
```

`engine.ts:993-1035` 消费逻辑改为遍历数组:逐个重建 tool_use block + 注入持久化结果或执行一次 + 聚合 events/results,然后进入 agentic loop。现有两个单数测试迁移为数组形态。

### 4.5 resume 入口(悬空兜底路径)

有 checkpoint 的恢复走现有 `agent:resume-run` → `LumeResumeService`(不动)。悬空兜底是新路径,服务于"崩溃且无 checkpoint":

`Agent.resumeInterruptedRun()`(新方法):

1. 已有 run 进行中 → 拒绝返回(复用现有运行中判断)
2. `detectDanglingToolUses(this.history)`:
   - 空 → 结束
   - 非末尾悬空(历史损坏)→ 不恢复,报 system 事件
3. 构造 `toolContinuations[]`,按 sidecar 保守语义分类:
   - 悬空工具为只读/无副作用 → 无 `toolResult` → 重放一次
   - 悬空工具为副作用型(以 tool 定义 `isReadOnly`/`isConcurrencySafe` 判断)→ 不重放,注入 error tool_result("interrupted before completion; actual state unknown — inspect before retrying")
4. 走现有 `submitMessage('', { toolContinuations })` 通路续跑
5. 恢复中途再次中断:resume 是普通 run,天然继承软 abort + message 级持久化,可无限次中断-恢复

配套 `Agent.discardInterruptedRun()`(用户拒绝恢复时调用):为悬空 tool_use 补 error tool_result(内容如 "discarded by user"),使 session 回到干净可用状态。

### 4.6 软 abort

`interrupt()` 语义调整(对齐 pi,阶段2 地基):

- abort 后:已开始的工具让完成、结果保留并持久化
- 未开始的工具不再执行
- 循环在批次边界停止,不再发起下一轮 LLM 请求
- **与 pi 的关键差异**:收尾时为未完成的 tool_use 补 error tool_result(内容如 "interrupted by user"),使 session 落在干净状态——主动中断不需要恢复流程,只有崩溃才需要
- 实现时需细查 engine 内现有 abort 路径(`executeTools` 并发批次对 signal 的响应),以本节语义为准

### 4.7 desktop / sidecar 集成(最小)

- sidecar 新增查询:给定 threadId,返回最后 run 的 `{ runState 终态, continuation 状态 }` → 是否存在待恢复中断
- desktop 打开会话时查询:有待恢复 → 提示"上次有未完成任务,是否继续?" → 确认走现有 `agent:resume-run`(有 checkpoint)或新的悬空兜底(无 checkpoint);拒绝则走 discard 清理

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| 节流写盘 IO 失败 | 吞掉 + console.warn,run 继续;finally 兜底写失败维持现有传播 |
| 恢复时 JSON 解析失败 / 非末尾悬空 | 不恢复,报 system 事件;回到现状(不更糟) |
| 重跑的副作用工具失败 | 与正常运行工具失败同路(error tool_result 进上下文,模型自行决策) |
| 恢复中再次中断 | resume 是普通 run,天然继承中断-恢复能力 |
| 运行中调用 resume | 拒绝返回 |

## 6. 测试策略(bun:test,StaticProvider 模式)

1. **数组 continuation 消费**(迁移现有 2 个单数测试):多悬空工具部分注入/部分重跑,验证 provider 收到的 messages 里 tool_use/tool_result 一一配对
2. **悬空检测纯函数**:末尾悬空 / 干净结尾 / 末尾 assistant 无工具 / 非末尾悬空(忽略)四类
3. **节流持久化**:fake timers 验证 leading+trailing 合并、finally 兜底、IO 失败不炸 run
4. **软 abort 语义**:多工具批次中 abort → 已开始工具结果保留在持久化 history、未开始不执行、无悬空 tool_use 落盘(验收标准:中断后 session 必须干净)
5. **恢复端到端**:构造中断态 session → `resumeInterruptedRun()` → 断言续跑请求配对正确;只读悬空重放、副作用悬空注入中断说明不重放

## 7. 阶段2 概述(不细化)

在阶段1 软 abort 之上加暂停状态机:

- `interrupt()` → `pause()`:批次边界停止,暂停点保存在内存(不依赖持久化)
- `resume()`:不冷启动,从内存暂停点原地继续下一轮 LLM 请求
- 基建:engine 主循环暴露暂停检查点、Agent 状态机(idle/streaming/paused)
- 细化前置条件:阶段1 落地验证后,评估原地续跑 vs 冷启动续跑的实际体验差距(prompt cache 命中率、延迟)再决定投入

## 8. 改动面清单

| 文件 | 改动 |
|---|---|
| `packages/sdk/src/types.ts` | `toolContinuations[]` 数组字段;abort 断点事件类型 |
| `packages/sdk/src/engine.ts` | 消费数组 continuation;软 abort(保留已完成结果 + 补 error tool_result + 发断点事件) |
| `packages/sdk/src/agent.ts` | 节流持久化、`resumeInterruptedRun()` / `discardInterruptedRun()` |
| `packages/sdk/src/interrupt-recovery.ts`(新) | `detectDanglingToolUses` 纯函数 |
| `apps/sidecar/.../runtime-core/run.ts` | 接收 abort 断点事件 → 写 RunContinuationState |
| `apps/sidecar/.../rpc/agent-handlers.ts` | 新增"待恢复中断"查询 + 悬空兜底 resume 入口 |
| desktop 会话打开处 | 待恢复检测 + 提示 + 调 resume/discard |

## 附录:pi 取证结论(2026-08-14,基于代码)

1. **持久化粒度 = message 级**,触发于 `message_end`(`agent-session.ts:656` → `session-manager.ts:_persist:1015`,同步 `appendFileSync`)。顺序执行边跑边写;并发执行整批完成后逐条写。首条 assistant 前不落盘(该窗口崩溃丢 user 消息)。
2. **abort = 软中断**(`agent.ts:319`):已开始工具结果保留(失败转 error result);未开始工具被 break 跳过且**不补 result**;`finishRun` 无条件清空 `pendingToolCalls`(`agent.ts:529-535`)。
3. **崩溃恢复不完整**:无未完成 run 标记,续接点 = 文件最后一条 entry(`session-manager.ts:_buildIndex:958-977`);重建为纯投影,**无 tool_use/tool_result 配对检查**(`sessionEntryToContextMessages:383-408`)——悬空 tool_use 原样灌入,下次 prompt 几乎必被 provider 拒。Lume 的 `toolContinuation` 正是修复此缺陷的机制。
