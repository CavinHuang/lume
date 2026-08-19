# Agent 事件总线 · 批次1(试点链)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 端到端打通"assistant 流式→落定"试点链的新事件总线:shared 单源类型 → SDK LifecycleProjector → sidecar ThreadEventBus(seq 持久化+微批推送)→ IPC(get-events 快照/续传 + agent:events 推送)→ web 消费,与旧路并行、feature flag 切换。

**Architecture:** engine 零改动(SDKMessage 为规范源),新事件为纯函数投影(旧→新);seq 由 sidecar ThreadEventBus 单写者分配,append-only events.jsonl,"持久化即承诺、推送只是加速";web 侧批次1 用新→旧适配器喂现有投影组件(UI 零改动,验证管线)。

**Tech Stack:** TypeScript(bun workspace),bun:test,jotai,Electron IPC(invoke/listen)。

**Spec:** `docs/superpowers/specs/2026-08-15-agent-event-bus-design.md`(本计划从 spec 出发,执行者两份都读)

## Global Constraints

- 测试运行器 `bun:test`(不是 vitest);组件测试参考 `PendingResumeBanner.test.tsx` 模式(mock.module + createRoot + act)
- 事件类型单源:`packages/shared/src/types/agent-events.ts`,SDK/sidecar/web 不得自定义重复副本
- 投递语义:推送失败不重试不阻塞(事件已持久化,重连补齐);**持久化即承诺,推送只是加速**
- seq 单写者 = ThreadEventBus(每线程);SDK 侧事件不带 seq
- 试点边界:仅主线程 run;`subagent_run_id` 非空的事件跳过
- 微批窗口 `16ms`(spec §4.2 必做项,常量命名 `UPDATE_COALESCE_MS`)
- feature flag `AGENT_LIFECYCLE_EVENTS`(生成与消费两端同 flag);flag off = 完全旧路,全量回归零变化
- commit 消息 emoji 前缀,末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`
- **执行前置:PR#82(中断可恢复)须已合并**;本计划在同分支续作
- sidecar 注释/文案中文;shared/sdk 类型注释英文(对齐各包现状)

## 已知事实(执行者必读,免重复取证)

- engine yield 点(规范源):`stream_event`(:1176/:1197)、`assistant` 终值(:1336)、`tool_result`(:1439)、`result`(:1528 终态);`SDKMessage` 联合在 `packages/sdk/src/types.ts:58-92`
- sidecar 消费管道:`run-loop.ts:30-63 consumeRuntimeCoreQueryStream`(for await → emit.onSdkMessage);flag 接线点在此
- 通道常量:`packages/shared/src/types/agent.ts:1881-2261 AGENT_IPC_CHANNELS`;handler 注册:`apps/sidecar/src/rpc/agent-handlers.ts`(`validateInput(schema, params, CHANNEL)` 模式,schemas 在 `apps/sidecar/src/rpc/schemas.ts`)
- 通知发射:`context.writeNotification(CHANNEL, payload)`(agent-handlers.ts 多处先例)
- 线程会话目录:`resolveRuntimeSessionDir(threadId)`(agent-handlers.ts:414 先例)
- web IPC 封装:`apps/web/src/lib/desktop-api/agent.ts`(:146-168 invoke 范本;:109-135 listen 范本)
- web 事件消费:`useGlobalAgentListeners.ts:147-221`(RUNTIME_EVENT 分支,rAF 批量 enqueueRuntimeEvent);投影 `runtime-event-message-projection.ts`(assistant.delta 累积 :279-297,run 终态 flush :410-438);去重合并 `runtime-event-state.ts:69-92`(按 event.id)
- **P4 修正**(相对 spec §1):web 消息列表由 runtime events 投影实时驱动,流式期间 assistant 已可见——试点验收是**管线等价/更优**,不是"提前可见"

---

### Task 1: shared 事件类型单源 + IPC 通道

**Files:**
- Create: `packages/shared/src/types/agent-events.ts`
- Modify: `packages/shared/src/types/agent.ts`(AGENT_IPC_CHANNELS 加两通道,GET_PENDING_RESUME :2102 附近)
- Test: `packages/shared/src/types/agent-events.test.ts`

**Interfaces:**
- Produces(Task 2-6 全部依赖):
  - `SdkEventEnvelope<T>`(字段:v/seq/threadId/runId/turnId/ts/kind/phase/detail)
  - `SdkLifecycleEvent`(无 seq 骨架事件:threadId? 由 sidecar 补,含 kind/phase/turnId/ts/runId/detail)
  - detail 类型:`RunStartDetail`/`RunEndDetail`/`TurnStartDetail`/`TurnEndDetail`/`MessageStartDetail`/`MessageUpdateDetail`/`MessageEndDetail`
  - `AgentEventsResult = { threadId: string; events: SdkEventEnvelope[] }`
  - 通道:`AGENT_IPC_CHANNELS.EVENTS = 'agent:events'`、`AGENT_IPC_CHANNELS.GET_EVENTS = 'agent:get-events'`

- [ ] **Step 1: 写失败测试**

```ts
// packages/shared/src/types/agent-events.test.ts
import { describe, expect, test } from "bun:test"
import { AGENT_IPC_CHANNELS } from "./agent.js"

describe("agent event bus channels", () => {
  test("exposes EVENTS push channel and GET_EVENTS request channel", () => {
    expect(AGENT_IPC_CHANNELS.EVENTS).toBe("agent:events")
    expect(AGENT_IPC_CHANNELS.GET_EVENTS).toBe("agent:get-events")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/shared && bun test src/types/agent-events.test.ts`
Expected: FAIL — `EVENTS` 不存在于 AGENT_IPC_CHANNELS

- [ ] **Step 3: 实现**

`packages/shared/src/types/agent.ts`(GET_PENDING_RESUME 行旁):

```ts
EVENTS: 'agent:events',
GET_EVENTS: 'agent:get-events',
```

`packages/shared/src/types/agent-events.ts`(新):

```ts
/**
 * Lifecycle event bus types — single vocabulary shared by SDK, sidecar and web.
 * Batch 1 scope: run + turn + assistant message lifecycle only.
 */

export type SdkEventKind = 'run' | 'turn' | 'message' | 'tool'
export type SdkEventPhase = 'start' | 'update' | 'end' | 'event'

/** Envelope assigned by the sidecar ThreadEventBus (single seq writer per thread). */
export interface SdkEventEnvelope<T = unknown> {
  v: 1
  seq: number
  threadId: string
  runId: string
  turnId: string | null
  ts: number
  kind: SdkEventKind
  phase: SdkEventPhase
  detail: T
}

/** Skeleton event emitted by the SDK projector; seq/threadId are filled by the bus. */
export interface SdkLifecycleEvent<T = unknown> {
  runId: string
  turnId: string | null
  ts: number
  kind: SdkEventKind
  phase: SdkEventPhase
  detail: T
}

export interface RunStartDetail {
  type: 'run.start'
}

export interface RunEndDetail {
  type: 'run.end'
  stopReason: string | null
  isError: boolean
  numTurns: number
  /** Migrated from the legacy SDKResultMessage when present. */
  usage?: Record<string, unknown>
  costUSD?: number
}

export interface TurnStartDetail {
  type: 'turn.start'
}

export interface TurnEndDetail {
  type: 'turn.end'
  /** Complete assistant message for this turn. */
  assistantMessage: { role: 'assistant'; content: unknown[] }
  /** All tool results collected during this turn, in tool_use order. */
  toolResults: Array<{ tool_use_id: string; tool_name?: string; content?: unknown; is_error?: boolean }>
}

export interface MessageStartDetail {
  type: 'message.start'
}

export interface MessageUpdateDetail {
  type: 'message.update'
  /** Native provider stream event (e.g. text_delta / input_json_delta), when available. */
  delta: { type: string; [key: string]: unknown } | null
  /** Folded cumulative partial — consumers never accumulate state themselves. */
  partial: { text: string; toolUses: Array<{ id: string; name: string; partialJson: string }> }
}

export interface MessageEndDetail {
  type: 'message.end'
  message: { role: 'assistant'; content: unknown[] }
  error?: string
}

export type Batch1LifecycleDetail =
  | RunStartDetail | RunEndDetail
  | TurnStartDetail | TurnEndDetail
  | MessageStartDetail | MessageUpdateDetail | MessageEndDetail

/** Result of AGENT_IPC_CHANNELS.GET_EVENTS. */
export interface AgentEventsResult {
  threadId: string
  events: SdkEventEnvelope[]
}
```

按包内导出惯例把新文件挂进 shared 的 index(查 `packages/shared/src/index.ts` 或 types 桶文件现有 re-export 方式,如 `export * from './types/agent-events.js'`)。

- [ ] **Step 4: 运行确认通过 + shared 全量**

Run: `cd packages/shared && bun test src/types/agent-events.test.ts && bun test`
Expected: PASS(基线 158+ 全绿)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/agent-events.ts packages/shared/src/types/agent-events.test.ts packages/shared/src/types/agent.ts
git commit -m "✨ feat(shared): 生命周期事件总线类型单源与 IPC 通道"
```

---

### Task 2: SDK LifecycleProjector 状态机

**Files:**
- Create: `packages/sdk/src/events/lifecycle-projector.ts`
- Modify: `packages/sdk/src/index.ts`(导出 `projectLifecycle` 与相关类型 re-export)
- Test: `packages/sdk/src/events/lifecycle-projector.test.ts`

**Interfaces:**
- Consumes: `SDKMessage`(types.ts:58,现有)、Task 1 的 `SdkLifecycleEvent`/detail 类型(从 `@lume/shared` 导入——先确认 SDK 的 shared 导入别名,查 SDK package.json/sidecar 的 import 先例;若无依赖则 `bun add @lume/shared` 工作区依赖)
- Produces: `projectLifecycle(messages: AsyncIterable<SDKMessage>): AsyncGenerator<SdkLifecycleEvent>`(Task 4 sidecar 消费)

**状态机规则(spec §4.1 逐条):**

```
run 边界:首条 assistant/stream_event/tool_result(跳过 init/system/auth_status 等)→ run.start
         旧 result 事件 → run.end(detail 迁移 stop_reason/is_error/num_turns/usage/costUSD)
turn 边界:turnId = assistant 消息 uuid(无 uuid 时用 `turn-${run 内序号}` 兜底)
         turn.start 于该 turn 首条 stream_event;无流式退化时与 message.start/end 由 assistant
         终值触发三连发(单次 drain 内:start→end→[turn.start 已先]? 注意顺序:
         无流式时为 turn.start→message.start→message.end,保持骨架完整)
         turn.end 于该 assistant 全部 tool_use 配对收齐后(detail 自携带 assistantMessage+toolResults)
         无 tool_use:turn.end 紧随 message.end
message 三段式:首条 stream_event→message.start;每条→message.update(delta=原生 event.event,
         partial=折叠累计 text/toolUses partialJson);assistant 终值→message.end(完整消息)
流式折叠:只处理 event.event.type 含 'text_delta'/'input_json_delta'/'thinking_delta'(content_block_delta
         家族);message_start/content_block_start 等不产生 update(delta=null 的 update 仅在
         首条任何 stream_event 后发一次?否——保持简单:仅 content_block_delta 家族发 update)
abort/error:assistant 终值带 error → message.end(带 error)+turn.end(toolResults=[])+
         run.end(stopReason='error'|'aborted');流式中断无终值时(projector 收到 result 前
         流终止)→ 由 result 事件兜底 run.end
tool_result 事件:按 tool_use_id 归入当前 pending turn;配对齐即发 turn.end
subagent:事件 subagent_run_id 非空 → 原样透传跳过(不产生骨架事件)
```

- [ ] **Step 1: 写失败测试(核心场景, StaticProvider 风格构造输入流)**

```ts
// packages/sdk/src/events/lifecycle-projector.test.ts
import { describe, expect, test } from "bun:test"
import { projectLifecycle } from "./lifecycle-projector.js"
import type { SDKMessage } from "../types.js"

/** 用固定消息序列驱动 projector,收集骨架事件 */
async function run(messages: SDKMessage[]): Promise<any[]> {
  async function* input() { for (const m of messages) yield m }
  const out: any[] = []
  for await (const ev of projectLifecycle(input())) out.push(ev)
  return out
}

const streamTextDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  parent_tool_use_id: null,
})
const assistantWithTool = (uuid: string) => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", content: [
    { type: "text", text: "hi" },
    { type: "tool_use", id: "t1", name: "Read", input: {} },
  ] },
})
const toolResult = (id: string) => ({
  type: "tool_result",
  result: { tool_use_id: id, tool_name: "Read", output: "ok", is_error: false },
})

describe("projectLifecycle", () => {
  test("single turn with tool: full skeleton, turn.end self-contained", async () => {
    const events = await run([
      streamTextDelta("he") as any,
      streamTextDelta("llo") as any,
      assistantWithTool("turn-a") as any,
      toolResult("t1") as any,
      { type: "result", subtype: "success", num_turns: 1 } as any,
    ])

    const kinds = events.map((e) => `${e.kind}.${e.phase}`)
    expect(kinds).toEqual([
      "run.start", "turn.start", "message.start",
      "message.update", "message.update", "message.end",
      "turn.end", "run.end",
    ])
    const turnEnd = events.find((e) => e.phase === "end" && e.kind === "turn")
    expect(turnEnd.turnId).toBe("turn-a")
    expect(turnEnd.detail.toolResults).toEqual([
      expect.objectContaining({ tool_use_id: "t1" }),
    ])
    expect(turnEnd.detail.assistantMessage.content).toHaveLength(2)
    const runEnd = events.at(-1)
    expect(runEnd.detail).toEqual(expect.objectContaining({ stopReason: "end_turn", numTurns: 1 }))
  })

  test("message.update carries folded cumulative partial", async () => {
    const events = await run([
      streamTextDelta("he") as any, streamTextDelta("llo") as any,
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } } as any,
    ])
    const updates = events.filter((e) => e.phase === "update")
    expect(updates[0].detail.partial.text).toBe("he")
    expect(updates[1].detail.partial.text).toBe("hello")
    expect(updates[1].detail.delta?.delta?.type).toBe("text_delta")
  })

  test("no-tool assistant: turn.end immediately after message.end", async () => {
    const events = await run([
      { type: "assistant", uuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } } as any,
    ])
    // 无流式退化:turn.start→message.start→message.end→turn.end 四连发(无 run.end,流未结束)
    expect(events.map((e) => `${e.kind}.${e.phase}`)).toEqual([
      "run.start", "turn.start", "message.start", "message.end", "turn.end",
    ])
  })

  test("error assistant: fallback chain message.end(error)→turn.end(∅)→run.end", async () => {
    const events = await run([
      streamTextDelta("par") as any,
      { type: "assistant", uuid: "u1", error: "server_error",
        message: { role: "assistant", content: [{ type: "text", text: "par" }] } } as any,
      { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1 } as any,
    ])
    const kinds = events.map((e) => `${e.kind}.${e.phase}`)
    expect(kinds).toEqual([
      "run.start", "turn.start", "message.start", "message.update",
      "message.end", "turn.end", "run.end",
    ])
    const msgEnd = events.find((e) => e.kind === "message" && e.phase === "end")
    expect(msgEnd.detail.error).toBe("server_error")
    expect(events.find((e) => e.kind === "turn" && e.phase === "end").detail.toolResults).toEqual([])
  })

  test("subagent events are skipped", async () => {
    const events = await run([
      { type: "assistant", subagent_run_id: "sub-1", uuid: "s-u",
        message: { role: "assistant", content: [] } } as any,
      { type: "assistant", uuid: "main-1",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } as any,
    ])
    expect(events.every((e) => e.turnId !== "s-u")).toBe(true)
    expect(events.some((e) => e.turnId === "main-1")).toBe(true)
  })

  test("multi-turn: turn boundary waits for full tool pairing per turn", async () => {
    const events = await run([
      assistantWithTool("t-a") as any,
      toolResult("t1") as any,
      assistantWithTool("t-b") as any,
      toolResult("t2") as any,
      { type: "result", subtype: "success", num_turns: 2 } as any,
    ])
    const turnEnds = events.filter((e) => e.kind === "turn" && e.phase === "end")
    expect(turnEnds.map((e) => e.turnId)).toEqual(["t-a", "t-b"])
    expect(turnEnds[0].detail.toolResults[0].tool_use_id).toBe("t1")
    expect(turnEnds[1].detail.toolResults[0].tool_use_id).toBe("t2")
    expect(events.at(-1).detail.numTurns).toBe(2)
  })
})
```

(注意第一个用例的 `stopReason: "end_turn"`:projector 从 result 事件的 `stop_reason` 字段迁移,无值时从 assistant message 推断或落 `null`——实现时以 SDKResultMessage 实际字段为准,断言随之微调并在报告记录。)

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/sdk && bun test src/events/lifecycle-projector.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现状态机**

`packages/sdk/src/events/lifecycle-projector.ts` 骨架(完整规则实现):

```ts
import type { SDKMessage } from '../types.js'
import type { SdkLifecycleEvent, Batch1LifecycleDetail } from '@lume/shared'
// 若 SDK 尚无 @lume/shared 依赖:查 package.json 加 workspace 依赖并在报告记录

interface PendingTurn {
  turnId: string
  toolUseIds: Set<string>
  toolResults: Array<Record<string, unknown>>
  started: boolean          // turn.start 是否已发
  messageStarted: boolean
  partialText: string
  partialToolUses: Array<{ id: string; name: string; partialJson: string }>
}

export async function* projectLifecycle(
  messages: AsyncIterable<SDKMessage>,
): AsyncGenerator<SdkLifecycleEvent<Batch1LifecycleDetail>> {
  let runStarted = false
  let currentTurn: PendingTurn | null = null

  const ts = () => Date.now()

  for await (const message of messages) {
    if ((message as any).subagent_run_id) continue
    // TODO per rule: dispatch on message.type — stream_event / assistant / tool_result / result / other
    // (完整分派逻辑按上方状态机规则实现;每条规则一个私有 helper,保持主循环可读)
    void message; void currentTurn; void runStarted; void ts
  }
  // 流终止而无 result:不发 run.end(真相由 sidecar 的旧 result 路径兜底;批次1 接受)
}
```

实现要点:`stream_event` 按 `event.event.type` 判别——`content_block_delta` 家族(text_delta/input_json_delta/thinking_delta)折叠进 partial 并发 update,首条任何 stream_event 触发 run.start(若未发)+turn.start+message.start;`assistant` 终值触发 message.end(把 content 归入 turn 的 assistantMessage)+ 无 tool_use 时 turn.end;`tool_result` 归入 pending turn、配对齐发 turn.end;`result` 触发 run.end(detail 从 subtype/is_error/num_turns/usage/total_cost_usd 迁移,stopReason 优先 `stop_reason` 字段、缺省按 subtype 映射 success→'end_turn')。

`packages/sdk/src/index.ts` 导出:

```ts
export { projectLifecycle } from './events/lifecycle-projector.js'
```

- [ ] **Step 4: 运行确认通过 + SDK 全量**

Run: `cd packages/sdk && bun test src/events/lifecycle-projector.test.ts && bun test`
Expected: PASS(基线 459 全绿,projector 是纯增量)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/events/lifecycle-projector.ts packages/sdk/src/events/lifecycle-projector.test.ts packages/sdk/src/index.ts packages/sdk/package.json
git commit -m "✨ feat(sdk): LifecycleProjector——SDKMessage 流投影为生命周期骨架事件"
```

---

### Task 3: sidecar ThreadEventBus(seq 分配 + jsonl 持久化 + 微批推送)

**Files:**
- Create: `apps/sidecar/src/services/agent-runtime/events/thread-event-bus.ts`
- Test: `apps/sidecar/src/services/agent-runtime/events/thread-event-bus.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SdkEventEnvelope`/`SdkLifecycleEvent`(`@lume/shared`)
- Produces(Task 4/5 依赖):

```ts
class ThreadEventBus {
  /** 盖信封、append 落盘、入微批队列;返回分配的 seq(落盘成功后 resolve)。 */
  publish(threadId: string, runId: string, event: SdkLifecycleEvent): Promise<number>
  /** 订阅实时推送(微批后);返回退订函数。 */
  subscribe(threadId: string, listener: (e: SdkEventEnvelope) => void): () => void
  /** 快照/续传:seq > afterSeq 的全部已持久化事件(afterSeq 缺省=全部=回放)。 */
  read(threadId: string, afterSeq?: number): Promise<SdkEventEnvelope[]>
}
export function getThreadEventBus(sessionDir: string): ThreadEventBus  // 每 sessionDir 单例
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/sidecar/src/services/agent-runtime/events/thread-event-bus.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getThreadEventBus } from "./thread-event-bus.js"

let dir: string
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined as any })

const skeletonEvent = (kind: any, phase: any, detail: any = { type: kind + "." + phase }) => ({
  runId: "r1", turnId: "t1", ts: 1, kind, phase, detail,
})

describe("ThreadEventBus", () => {
  test("assigns monotonic seq per thread and persists append-only", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const s1 = await bus.publish("th1", "r1", skeletonEvent("message", "update"))
    const s2 = await bus.publish("th1", "r1", skeletonEvent("message", "update"))
    const other = await bus.publish("th2", "r1", skeletonEvent("run", "start"))
    expect(s2).toBe(s1 + 1)
    expect(other).toBe(1) // per-thread seq

    const all = await bus.read("th1")
    expect(all.map((e) => e.seq)).toEqual([1, 2])
    expect(all[0].threadId).toBe("th1")
    expect(all[0].v).toBe(1)
  })

  test("read(afterSeq) returns pure increment", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    await bus.publish("th1", "r1", skeletonEvent("run", "start"))
    await bus.publish("th1", "r1", skeletonEvent("message", "end"))
    const inc = await bus.read("th1", 1)
    expect(inc.map((e) => e.seq)).toEqual([2])
  })

  test("coalesces same kind+phase updates within 16ms window", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const received: SdkEventEnvelope[] = []  // type import from @lume/shared
    bus.subscribe("th1", (e) => received.push(e))
    await bus.publish("th1", "r1", skeletonEvent("message", "update", { type: "message.update", delta: null, partial: { text: "a", toolUses: [] } }))
    await bus.publish("th1", "r1", skeletonEvent("message", "update", { type: "message.update", delta: null, partial: { text: "ab", toolUses: [] } }))
    await new Promise((r) => setTimeout(r, 40))
    // 持久化 2 条(都落盘),推送只收到最后一条(折叠)
    expect(received).toHaveLength(1)
    expect((received[0].detail as any).partial.text).toBe("ab")
    expect((await bus.read("th1")).length).toBe(2)
  })

  test("non-update phases are pushed immediately without coalescing", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    const received: SdkEventEnvelope[] = []
    bus.subscribe("th1", (e) => received.push(e))
    await bus.publish("th1", "r1", skeletonEvent("turn", "end"))
    await bus.publish("th1", "r1", skeletonEvent("run", "end"))
    expect(received.map((e) => e.phase)).toEqual(["end", "end"])
  })

  test("new instance on same dir resumes seq and reads torn tail safely", async () => {
    dir = mkdtempSync(join(tmpdir(), "bus-"))
    const bus = getThreadEventBus(dir)
    await bus.publish("th1", "r1", skeletonEvent("run", "start"))
    // 模拟半行尾(断电)
    const { appendFileSync } = await import("node:fs")
    appendFileSync(join(dir, "th1.events.jsonl"), '{"seq":2,"bro')
    const bus2 = getThreadEventBus(dir)  // 同目录新实例(进程重启)
    const events = await bus2.read("th1")
    expect(events.map((e) => e.seq)).toEqual([1])       // 半行被截断
    const s = await bus2.publish("th1", "r1", skeletonEvent("message", "end"))
    expect(s).toBe(2)                                     // 序号续上而非重写
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/events/thread-event-bus.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

```ts
// apps/sidecar/src/services/agent-runtime/events/thread-event-bus.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SdkEventEnvelope, SdkLifecycleEvent } from "@lume/shared"

const UPDATE_COALESCE_MS = 16

interface ThreadState {
  nextSeq: number
  listeners: Set<(e: SdkEventEnvelope) => void>
  /** 微批缓冲:key=`kind:phase:turnId`,value=最新 envelope;定时器统一 flush */
  coalesceBuffer: Map<string, SdkEventEnvelope>
  coalesceTimer: ReturnType<typeof setTimeout> | null
}

export class ThreadEventBus { /* publish/subscribe/read 按 Interfaces 契约与测试行为实现 */ }
const instances = new Map<string, ThreadEventBus>()
export function getThreadEventBus(sessionDir: string): ThreadEventBus {
  let bus = instances.get(sessionDir)
  if (!bus) instances.set(sessionDir, bus = new ThreadEventBus(sessionDir))
  return bus
}
```

实现要点:
- 存储文件:`<sessionDir>/<threadId>.events.jsonl`,每行一个 envelope(appendFileSync;与 Task 7 abort-continuation 的原子写不同——append 本身幂等于行,半行由读取侧截断)
- `nextSeq` 初始化:readFileSync 扫描最后一行 seq(不存在则 0);读取侧遇非法 JSON 行即截断后续
- 微批:publish 时 phase==='update' 入 buffer(替换同 key 旧值,即"折叠后 partial")并 lazily 起 16ms 定时器,flush 时按插入序推给 listeners;非 update 相位**先 flush 挂起的 update(保序)再立即推送**(同 turn 的 message.end 必须晚于其 update——测试 `turn.end` 用例隐含此序)
- publish 的 Promise 在 appendFileSync 完成后 resolve(同步 append 即 resolve;持久化即承诺)
- 注释中文

- [ ] **Step 4: 运行确认通过 + sidecar 全量**

Run: `cd apps/sidecar && bun test src/services/agent-runtime/events/thread-event-bus.test.ts && bun run test:unit`
Expected: PASS(基线 247 pass + 1 whoami 环境性 fail)

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/events/thread-event-bus.ts apps/sidecar/src/services/agent-runtime/events/thread-event-bus.test.ts
git commit -m "✨ feat(sidecar): ThreadEventBus——seq 单写者/append-only 持久化/16ms 微批推送"
```

---

### Task 4: sidecar 接线——run-loop 投影 + IPC(get-events / agent:events)+ feature flag

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-loop.ts`(consumeRuntimeCoreQueryStream ~30-63)
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`(注册 GET_EVENTS handler;通知能力)
- Modify: `apps/sidecar/src/rpc/schemas.ts`(getEventsInputSchema)
- Modify: flag 读取处(执行时定位:查现有 env/配置开关的先例,`grep -rn "process.env.LUME\|AGENT_" apps/sidecar/src --include="*.ts" | grep -i flag | head`;若无先例则用 `process.env.AGENT_LIFECYCLE_EVENTS === '1'`)
- Test: `apps/sidecar/src/rpc/agent-handlers.events.test.ts`(新)

**Interfaces:**
- Consumes: `projectLifecycle`(Task 2)、`getThreadEventBus`(Task 3)、`resolveRuntimeSessionDir`
- Produces: IPC 行为——`agent:get-events` 返回 `AgentEventsResult`;run 进行中事件经 `agent:events` 通道推送(`context.writeNotification(AGENT_IPC_CHANNELS.EVENTS, envelope)`)

**接线设计(run-loop):**

```
consumeRuntimeCoreQueryStream 内(flag on 时):
  const original = query                      // agent.query() 生成器
  query = teeStream(original)                 // 拆双订阅:主流照旧(旧投影零变化),
                                              // 支流 pipe projectLifecycle → bus.publish
```

tee 实现注意:生成器只能有一个消费者——用缓冲广播包装(读主循环拉取驱动,支路事件排入队列,publish 异步执行不阻塞主流;`void Promise.all` 或逐条 then)。**最小实现**:包装生成器转发每个 chunk 时同步喂 projector(projector 是同步状态机,异步只是接口形态),产物 publish;旧路径拿到的还是原 SDKMessage 序列。

**get-events handler:**

```ts
// agent-handlers.ts(RESUME_RUN 注册旁)
AGENT_IPC_CHANNELS.GET_EVENTS: async (params: unknown) => {
  const input = validateInput(getEventsInputSchema, params, AGENT_IPC_CHANNELS.GET_EVENTS)
  const sessionDir = resolveRuntimeSessionDir(input.threadId)
  const events = await getThreadEventBus(sessionDir).read(input.threadId, input.afterSeq)
  return { threadId: input.threadId, events }
}
```

`schemas.ts`:`export const getEventsInputSchema = z.object({ threadId: idSchema, afterSeq: z.number().int().nonnegative().optional() })`(对齐文件内现有 schema 风格,idSchema 名以文件实际为准)。

**推送接线**:bus 的订阅者在 handler 装配处建立(参考 resumeRunForThread 内 context.writeNotification 的可达性——需要 run 生命周期内持有 context;实现时把 `context.writeNotification` 经 emit 回调传入 bus 订阅,粒度为该 threadId)。

- [ ] **Step 1: 写失败测试**

```ts
// apps/sidecar/src/rpc/agent-handlers.events.test.ts
import { describe, expect, test } from "bun:test"
// 构造方式参考同目录 agent-handlers.runtime-state.test.ts 的 harness
// 用例 1:get-events 空线程返回 { threadId, events: [] }
// 用例 2:向 bus publish 三条后 read 回 seq [1,2,3];afterSeq=2 只回 [3]
// 用例 3(flag off):run-loop 消费 SDKMessage 流后 bus 无事件(旧路不触发新总线)
// 用例 4(flag on):mock 最小 SDKMessage 流(stream_event+assistant+result)
//   → bus 收到 run.start…run.end 骨架事件(kind/phase 序列断言)
```

(具体 mock 形态执行时对照 runtime-state.test.ts 的现有 harness 落地;断言以 Task 2 的骨架序列为准。)

- [ ] **Step 2: 运行确认失败** → Run: `cd apps/sidecar && bun test src/rpc/agent-handlers.events.test.ts` Expected: FAIL(handler 未注册)

- [ ] **Step 3: 实现**(按上方接线设计;flag 默认 off,测试内显式开)

- [ ] **Step 4: 运行确认通过 + 全量 + typecheck**

Run: `cd apps/sidecar && bun test src/rpc/agent-handlers.events.test.ts && bun run test:unit && bun run typecheck`
Expected: PASS(基线不变;flag off 路径零行为变化)

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/runner/run-loop.ts apps/sidecar/src/rpc/agent-handlers.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/agent-handlers.events.test.ts
git commit -m "✨ feat(sidecar): run-loop 接入 LifecycleProjector + get-events/agent:events IPC(AGENT_LIFECYCLE_EVENTS flag)"
```

---

### Task 5: web desktop-api 封装 + useAgentEventBus hook

**Files:**
- Modify: `apps/web/src/lib/desktop-api/agent.ts`(getAgentEvents + onAgentEvents)
- Create: `apps/web/src/hooks/useAgentEventBus.ts`
- Test: `apps/web/src/hooks/useAgentEventBus.test.ts`

**Interfaces:**
- Consumes: Task 1 通道与类型;`invoke`/`listen`(`@/lib/desktop-runtime/core`);flag(同 sidecar,web 侧读取方式对齐现有 env/配置暴露——执行时查 web 是否能读进程 env,若不能则经 desktop-api 暴露 `isLifecycleEventsEnabled()` 封装)
- Produces(Task 6 消费):`useAgentEventBus(threadId, options?: { onEvent: (e: SdkEventEnvelope) => void, enabled: boolean })`——内部完成快照/续传/归并,回调收到**已按 seq 去重排序**的事件流;hook 自己不写 atom(保持消费者自由)

- [ ] **Step 1: 写失败测试**(bun:test + fake DOM,mock desktop-api,参考 useGlobalAgentListeners 若有测试先例否则参考组件测试 mock.module 模式)

```ts
// 用例 1:挂载 → 先拉 getAgentEvents(无 afterSeq)= 全量,回调按 seq 顺序收到
// 用例 2:已收到最大 seq=5 → 线程切换重挂 → getAgentEvents 带 afterSeq=5
// 用例 3:push 与 pull 交叠(拉取返回 seq[1,2],push 到达 seq 1,2,3)→ 回调只收到 1,2,3 各一次且有序
// 用例 4:push 到达 seq 5 而本地最大 3(空洞)→ 触发全量重拉(getAgentEvents 无 afterSeq)
// 用例 5:threadId 切换 → 清空本地 seq 状态与回调队列
```

- [ ] **Step 2: 运行确认失败** → Run: `cd apps/web && bun test src/hooks/useAgentEventBus.test.ts` Expected: FAIL

- [ ] **Step 3: 实现**

`desktop-api/agent.ts` 追加(照 :152-156 与 :109-135 范本):

```ts
export const getAgentEvents = (threadId: string, afterSeq?: number) =>
  invoke<AgentEventsResult>('sidecar_call', {
    method: AGENT_IPC_CHANNELS.GET_EVENTS,
    params: { threadId, ...(afterSeq !== undefined ? { afterSeq } : {}) },
  })

export const onAgentEvents = (cb: (e: SdkEventEnvelope) => void) =>
  listen<SdkEventEnvelope>(AGENT_IPC_CHANNELS.EVENTS, (ev) => cb(ev.payload))
```

`useAgentEventBus.ts` 核心(快照+归并逻辑):

```ts
export function useAgentEventBus(
  threadId: string,
  options: { enabled: boolean; onEvent: (e: SdkEventEnvelope) => void },
): void {
  // 状态:localMaxSeqRef(threadId → max seq)、pending 归并缓冲
  // 流程:effect(threadId) → getAgentEvents(threadId, localMaxSeqRef)
  //   → 依 seq 排序逐条 onEvent、更新 localMaxSeqRef
  //   → onAgentEvents 订阅:按 threadId 过滤;
  //      e.seq === localMax+1 → 直接 onEvent;
  //      e.seq <= localMax → 丢弃(重拉交叠);
  //      e.seq > localMax+1 → 入缓冲,触发全量重拉(空洞),重拉后缓冲与结果归并
  // 清理:unlisten + 重置该 thread 的 localMaxSeq
}
```

(缓冲最小实现:重拉结果直接覆盖本地状态并重放窗口内事件即可,不追求复杂缓冲结构。)

- [ ] **Step 4: 运行确认通过 + web 全量**

Run: `cd apps/web && bun test src/hooks/useAgentEventBus.test.ts && bun run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/desktop-api/agent.ts apps/web/src/hooks/useAgentEventBus.ts apps/web/src/hooks/useAgentEventBus.test.ts
git commit -m "✨ feat(web): useAgentEventBus——快照+seq 续传消费 hook"
```

---

### Task 6: 试点链切换(新→旧适配器喂现有投影)+ flag + 验收

**Files:**
- Create: `apps/web/src/hooks/lifecycle-event-adapter.ts`(新骨架事件 → 等价 RuntimeEvent)
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`(flag on 时挂 useAgentEventBus,适配产物走 enqueueRuntimeEvent 同路径)
- Test: `apps/web/src/hooks/lifecycle-event-adapter.test.ts`

**Interfaces:**
- Consumes: Task 5 hook、现有 `enqueueRuntimeEvent`/`appendRuntimeEvents`(useGlobalAgentListeners.ts:97-112)与 `agentStreamingStatesAtom` 写入路径
- Produces: flag on 时试点链 UI 由新总线驱动(UI 组件与投影**零改动**——批次1 的过渡适配器,批次5 删除)

**适配映射(批次1 全集):**

```
message.start                → (流式开始;置 streaming 态,无 RuntimeEvent 等价物,可只置状态)
message.update(partial.text) → assistant.delta { text: partial.text 增量 }
                               (注意:partial 是累计值,适配时对上一 partial 求差;
                                hook 内维护 lastTextRef)
message.end                  → assistant.final { blocks: detail.message.content }
turn.end                     → (无直接等价;批次1 不产 RuntimeEvent——turn 落定语义由
                               message.end 的 assistant.final 已覆盖现有投影行为)
run.end(stopReason/isError)  → isError ? run.failed : (numTurns 达上限? run.turn_limited : run.completed)
subagent 事件/其他            → 忽略(批次1 总线本就只含主线程试点链)
```

- [ ] **Step 1: 写失败测试**(适配器纯函数测试:骨架事件序列 → RuntimeEvent 序列断言;含 text 求差、run.end 三分支)

- [ ] **Step 2: 运行确认失败** → Run: `cd apps/web && bun test src/hooks/lifecycle-event-adapter.test.ts` Expected: FAIL

- [ ] **Step 3: 实现**

适配器纯函数 + useGlobalAgentListeners 内 flag 分支:

```ts
// flag on:挂载 useAgentEventBus(threadId, { enabled, onEvent: (e) => {
//   const runtimeEvents = adaptLifecycleEvent(e, lastTextRef.current)
//   runtimeEvents.forEach((re) => enqueueRuntimeEvent(re))   // 复用 rAF 批量与既有 atom 路径
// } })
// flag off:不挂载,现状零变化
// flag on 时,旧 RUNTIME_EVENT 分支对试点链事件类型(assistant.delta/assistant.final/run.*)
//   停止处理(避免双写):由 enabled 检查在旧分支入口跳过
```

(旧分支跳过的精确范围执行时核对:sidecar flag on 时旧投影对试点链是否仍发 RuntimeEvent——Task 4 接线只加不改,旧路照发;则 web 需按 flag 跳过试点链类型避免重复。若发现 sidecar 侧按 flag 停发更干净,在 Task 4 补 flag off 的旧投影短路并在两处报告对齐——**单一真相源原则:同链路同时刻只能一条路**。)

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `cd apps/web && bun test && bun run typecheck && cd ../.. && cd apps/sidecar && bun run test:unit`
Expected: PASS;flag off 全量零变化

- [ ] **Step 5: 手动验收(试点链端到端)**

```
1. AGENT_LIFECYCLE_EVENTS=1 启动 desktop
2. 发起带工具调用的多轮任务,观察:流式渲染正常、工具后继续流式、run 结束落定
3. 流式中杀掉 web(devtools 断开)→ 恢复 → 会话状态一致(get-events 续传)
4. 重启 sidecar → 重开线程 → 历史流式回放(events.jsonl 回放)
5. flag off → 行为与现状完全一致
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/hooks/lifecycle-event-adapter.ts apps/web/src/hooks/lifecycle-event-adapter.test.ts apps/web/src/hooks/useGlobalAgentListeners.ts
git commit -m "✨ feat(web): 试点链切换生命周期事件总线(新→旧适配器,flag 控制)"
```

---

## 任务依赖

```
Task 1(shared 类型+通道) ──▶ Task 2(SDK projector) ──▶ Task 4(sidecar 接线) ──▶ Task 6(web 切换)
                       └───▶ Task 3(ThreadEventBus) ──┘        └──▶ Task 5(web hook) ──┘
```

(Task 2 与 Task 3 在 Task 1 后可并行;Task 5 依赖 Task 1 类型与 Task 4 的 IPC 存在,但代码上只依赖类型,可与 Task 4 并行开发、Task 6 前合流。)

## 验收(整体)

1. 各包测试全绿(sdk 459+ / sidecar 247+1 环境性 / shared 159+ / web 全量);typecheck 四包绿
2. flag off:全量回归零变化(回滚开关有效)
3. flag on 手动验收五步通过(上 Task 6 Step 5)
4. 试点链事件在 events.jsonl 可查、seq 连续无空洞;断线重连不丢不重
