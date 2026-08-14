# Agent 中断可恢复 阶段1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把硬 abort 升级为软中断,补齐 abort/崩溃场景的断点捕获、message 级持久化与恢复入口,复用 sidecar 已有的 RunContinuationState 恢复体系。

**Architecture:** SDK 层(engine/agent)提供软 abort 语义、数组化 toolContinuation、悬空检测与 resume/discard 入口;sidecar 层捕获 abort 断点写入现有 RunContinuationStore 并新增待恢复查询;desktop 在会话打开时提示恢复。spec 见 `docs/superpowers/specs/2026-08-14-agent-interrupt-recovery-design.md`。

**Tech Stack:** TypeScript(bun workspace),测试用 bun:test + StaticProvider 模式(参考 `packages/sdk/src/engine.test.ts`)。

## Global Constraints

- 测试运行器是 `bun:test`,不是 vitest;组件测试参考 `AgentView.test.tsx` 的 fake DOM 模式
- worktree 内改动;worktree 缺 node_modules 时先 `bun install`(见 memory)
- 副作用重放语义必须对齐 sidecar 保守策略:execute 型工具结果未知禁止重放,注入中断说明
- 注释语言与所在文件现有注释语言保持一致(sdk 多为英文注释,sidecar 混合)
- 每个 commit 遵循仓库 emoji 前缀风格(参考 `git log`:🔥 remove / ✨ 等)
- 禁止在 main 直接改动;本 worktree 分支上开发,经 PR 合并(项目 CLAUDE.md §5)
- 改动遵循 surgical changes:只动本任务列出的文件与行

## 背景速览(执行者必读)

- `packages/sdk/src/engine.ts` 的 `toolContinuation` 消费段(约 988-1035 行):从持久化工具边界冷启动恢复——有 `toolResult` 注入不重跑,无则执行一次。当前仅支持单工具。
- `packages/sdk/src/agent.ts` 的 `runSinglePrompt`(883 起):每次 prompt 创建 AbortController(902-903);for-await 消费 engine 事件并 push sessionMessages(1067-1096);`finally` 里 run 级持久化(1097-1108)。
- abort 现状:`interrupt()` = `abortCtrl.abort('interrupt')`(agent.ts:1219);engine 内 30+ 处 `throw new Error('aborted')`,其中 `executeTools` 在批次边界 abort 会丢弃已完成批次结果(engine.ts:1585/1592/1605/1607)。
- sidecar 恢复体系:`RunContinuationState`(apps/sidecar/src/services/agent-runtime/runner/run-continuation.ts)、`LumeResumeService`(interruption/resume-service.ts)、`agent:resume-run` IPC(apps/sidecar/src/rpc/agent-handlers.ts:409 起)。checkpoint 目前只在审批/ask_user 暂停时写入。
- sidecar 的 `handleAsyncEvent`(runtime-core/run.ts:1797)已有 "system/task_notification → continuationStore.update" 先例可仿。

---

### Task 1: 悬空 tool_use 检测纯函数

**Files:**
- Create: `packages/sdk/src/interrupt-recovery.ts`
- Test: `packages/sdk/src/interrupt-recovery.test.ts`

**Interfaces:**
- Consumes: `NormalizedMessageParam`(from `./types.js`)
- Produces: `detectDanglingToolUses(messages: NormalizedMessageParam[]): DanglingToolUse[]`,`DanglingToolUse = { id: string; name: string; input: unknown }`(Task 5 消费)

- [ ] **Step 1: 写失败测试**

```ts
// packages/sdk/src/interrupt-recovery.test.ts
import { describe, expect, test } from "bun:test"
import { detectDanglingToolUses } from "./interrupt-recovery.js"

const assistantWithTools = (id: string, name: string, input: unknown) => ({
  role: "assistant" as const,
  content: [{ type: "tool_use" as const, id, name, input }],
})
const toolResultFor = (id: string, content = "ok") => ({
  role: "user" as const,
  content: [{ type: "tool_result" as const, tool_use_id: id, content }],
})

describe("detectDanglingToolUses", () => {
  test("returns unanswered tool_use from the trailing assistant", () => {
    const messages: any[] = [
      { role: "user", content: "do it" },
      assistantWithTools("t1", "Read", { path: "a.ts" }),
      toolResultFor("t1"),
      assistantWithTools("t2", "Bash", { command: "ls" }),
      // t2 无 tool_result → 悬空
    ]
    expect(detectDanglingToolUses(messages)).toEqual([
      { id: "t2", name: "Bash", input: { command: "ls" } },
    ])
  })

  test("returns empty when the conversation ends cleanly", () => {
    const messages: any[] = [
      { role: "user", content: "do it" },
      assistantWithTools("t1", "Read", { path: "a.ts" }),
      toolResultFor("t1"),
    ]
    expect(detectDanglingToolUses(messages)).toEqual([])
  })

  test("returns empty when the trailing assistant has no tool_use", () => {
    const messages: any[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    expect(detectDanglingToolUses(messages)).toEqual([])
  })

  test("ignores dangling tool_use in earlier assistants (historical damage)", () => {
    const messages: any[] = [
      assistantWithTools("t0", "Read", { path: "old.ts" }),
      // t0 悬空但被后面的 assistant 覆盖 → 历史损坏,忽略
      assistantWithTools("t1", "Read", { path: "a.ts" }),
      toolResultFor("t1"),
    ]
    expect(detectDanglingToolUses(messages)).toEqual([])
  })

  test("handles multiple dangling tool_use in one assistant", () => {
    const messages: any[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "Read", input: { path: "a" } },
          { type: "tool_use", id: "b", name: "Edit", input: { path: "b" } },
        ],
      },
      toolResultFor("a"),
      // b 悬空
    ]
    expect(detectDanglingToolUses(messages)).toEqual([
      { id: "b", name: "Edit", input: { path: "b" } },
    ])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/sdk && bun test src/interrupt-recovery.test.ts`
Expected: FAIL — 模块 `./interrupt-recovery.js` 不存在

- [ ] **Step 3: 最小实现**

```ts
// packages/sdk/src/interrupt-recovery.ts
import type { NormalizedMessageParam } from './types.js'

export interface DanglingToolUse {
  id: string
  name: string
  input: unknown
}

/**
 * Detect tool_use blocks in the trailing assistant message that have no
 * matching tool_result — the residue of an interrupted or crashed run.
 * Only the trailing assistant is inspected; earlier gaps are historical
 * damage and are intentionally ignored.
 */
export function detectDanglingToolUses(messages: NormalizedMessageParam[]): DanglingToolUse[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const blocks = message.content as Array<Record<string, unknown>>
    const toolUses = blocks.filter((block) => block.type === 'tool_use')
    if (toolUses.length === 0) continue

    const answered = new Set<string>()
    for (let j = i + 1; j < messages.length; j++) {
      const later = messages[j] as { role?: string; content?: unknown }
      if (later.role !== 'user' || !Array.isArray(later.content)) continue
      for (const block of later.content as Array<Record<string, unknown>>) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          answered.add(block.tool_use_id)
        }
      }
    }
    return toolUses
      .filter((block) => !answered.has(block.id as string))
      .map((block) => ({
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      }))
  }
  return []
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/sdk && bun test src/interrupt-recovery.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/interrupt-recovery.ts packages/sdk/src/interrupt-recovery.test.ts
git commit -m "✨ feat(sdk): add dangling tool_use detector for interrupt recovery"
```

---

### Task 2: toolContinuation 数组化

**Files:**
- Modify: `packages/sdk/src/types.ts:1529`(AgentOptions)、`packages/sdk/src/types.ts:1624`(QueryEngineConfig)
- Modify: `packages/sdk/src/engine.ts:988-1035`(消费段)
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts:2256/2319`(唯一生产调用方)
- Modify: `packages/sdk/src/index.ts:646`(导出不变,`PersistedToolContinuation` 类型保留)
- Test: `packages/sdk/src/engine.test.ts:120-220`(迁移现有 2 个测试)

**Interfaces:**
- Consumes: `PersistedToolContinuation`(types.ts:900,元素类型不变)
- Produces: `AgentOptions.toolContinuations?: PersistedToolContinuation[]`、`QueryEngineConfig.toolContinuations?: PersistedToolContinuation[]`(Task 5/7 消费;单数字段 `toolContinuation` 删除)

- [ ] **Step 1: 迁移现有测试到数组形态并新增多工具用例**

把 `engine.test.ts:120` 测试的配置改为:

```ts
toolContinuations: [
  { toolCall: { id: "tool-resume-1", name: "Read", input: { file_path: "README.md" } } },
],
```

把 `engine.test.ts:170` 测试的配置改为:

```ts
toolContinuations: [
  {
    toolCall: { id: "tool-resume-2", name: "Bash", input: { command: "bun test" } },
    toolResult: { type: "tool_result", tool_use_id: "tool-resume-2", content: "2 pass" },
  },
],
```

并新增混合用例(追加到同 describe 块):

```ts
test("mixed continuations replay some tools and inject others", async () => {
  let calls = 0
  const provider = new StaticProvider([{
    content: [{ type: "text", text: "mixed resumed" }],
    stopReason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  }])
  const engine = new QueryEngine({
    cwd: process.cwd(),
    model: "test-model",
    provider,
    tools: [{
      name: "Read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      async call() {
        calls += 1
        return { type: "tool_result", tool_use_id: "", content: "replayed" }
      },
    }],
    systemPrompt: "test",
    maxTurns: 1,
    maxTokens: 256,
    includePartialMessages: false,
    canUseTool: async () => ({ behavior: "allow" }),
    toolContinuations: [
      { toolCall: { id: "t-inject", name: "Read", input: { file_path: "x" } },
        toolResult: { type: "tool_result", tool_use_id: "t-inject", content: "injected" } },
      { toolCall: { id: "t-replay", name: "Read", input: { file_path: "y" } } },
    ],
  })

  await collectEvents(engine)

  expect(calls).toBe(1) // 只有 t-replay 重放
  const request = provider.requests[0]?.messages as any[]
  const toolResults = request.flatMap((m) => Array.isArray(m.content) ? m.content : [])
    .filter((c: any) => c.type === "tool_result")
  const ids = toolResults.map((c: any) => c.tool_use_id).sort()
  expect(ids).toEqual(["t-inject", "t-replay"])
})
```

(若 `collectEvents` 需要空 prompt 之外的签名,参考同文件现有用法。)

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/sdk && bun test src/engine.test.ts`
Expected: FAIL — `toolContinuations` 类型不存在

- [ ] **Step 3: 类型与引擎改造**

types.ts 两处(1529/1624):

```ts
/** Host-owned exact tool continuations restored after a cold start. */
toolContinuations?: PersistedToolContinuation[]
```

(删除原单数字段及注释;grep `toolContinuation` 确认无其他引用:`grep -rn "toolContinuation" packages apps --include="*.ts" | grep -v Continuations | grep -v test`。)

engine.ts 消费段(988-1035)替换为:

```ts
// Exact cold-start continuations resume at the persisted tool boundary,
// so they must not add a second model-facing user prompt.
let protectedMessageIndex: number | undefined
if (!this.config.toolContinuations?.length) {
  protectedMessageIndex = this.messages.length
  this.messages.push({ role: 'user', content: prompt as any })
}

if (this.config.toolContinuations?.length) {
  const continuations = this.config.toolContinuations
  const blocks: ToolUseBlock[] = continuations.map((persisted) => ({
    type: 'tool_use',
    id: persisted.toolCall.id,
    name: persisted.toolCall.name,
    input: persisted.toolCall.input,
  }))
  // Idempotent rebuild: only push the assistant blocks if not already present.
  const missing = blocks.filter((block) => !this.messages.some((message) => (
    message.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((content) => content.type === 'tool_use' && content.id === block.id)
  )))
  if (missing.length > 0) {
    this.messages.push({ role: 'assistant', content: missing })
  }
  const allEvents = []
  const allResults = []
  for (const [index, persisted] of continuations.entries()) {
    const block = blocks[index]
    const execution = persisted.toolResult
      ? { results: [{ ...persisted.toolResult, tool_use_id: block.id, tool_name: block.name }], events: [], toolsUsed: [block.name] }
      : await this.executeTools([block])
    allEvents.push(...execution.events)
    allResults.push(...execution.results)
  }
  for (const event of allEvents) yield event
  for (const result of allResults) {
    yield {
      type: 'tool_result',
      result: {
        tool_use_id: result.tool_use_id,
        tool_name: result.tool_name || continuations[allResults.indexOf(result)]?.toolCall.name,
        output: formatToolResultOutput(result.content),
        content: result.content,
        is_error: result.is_error === true,
        ...(result._meta ? { _meta: result._meta } : {}),
      },
    }
  }
  this.messages.push({
    role: 'user',
    content: allResults.map((result) => ({
      type: 'tool_result' as const,
      tool_use_id: result.tool_use_id,
      content: result.content,
      is_error: result.is_error,
      ...(result._meta ? { _meta: result._meta } : {}),
    })),
  })
}
```

注意:保留原实现的 `agent.ts:959/1005/1104` 透传链路中对旧字段名的引用一并改为 `toolContinuations`(agent.ts 三处 + run.ts:2256 的 `resolvePersistedToolContinuation` 返回值包装为数组、run.ts:2319 字段名)。

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `cd packages/sdk && bun test src/engine.test.ts && bun test`
Expected: PASS(含迁移后的 3 个 continuation 测试)

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/types.ts packages/sdk/src/engine.ts packages/sdk/src/agent.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts packages/sdk/src/engine.test.ts
git commit -m "♻️ refactor(sdk): toolContinuation → toolContinuations[] for multi-tool boundaries"
```

---

### Task 3: message 级节流持久化

**Files:**
- Modify: `packages/sdk/src/agent.ts`(runSinglePrompt 事件循环 ~1067-1096 + 类字段)
- Test: `packages/sdk/src/agent-persist.test.ts`(新建)

**Interfaces:**
- Consumes: 现有 `persistCurrentSession(cwd, opts)`(agent.ts:848,内部已 catch)
- Produces: `Agent` 内部 `schedulePersist(cwd, opts)` 私有方法;run 结束 finally 兜底不变

- [ ] **Step 1: 写失败测试**

```ts
// packages/sdk/src/agent-persist.test.ts
import { describe, expect, test, vi } from "bun:test"

describe("message-level throttled persistence", () => {
  test("schedules a trailing write once per 200ms window", async () => {
    vi.useFakeTimers()
    // 构造最小 Agent 实例困难(依赖 provider/tools),直接测私有节流器:
    // 将节流逻辑提取为可导出的纯工具函数 createPersistScheduler(见 Step 3)
    const writes: string[] = []
    const schedule = createPersistScheduler(200, async (tag) => { writes.push(tag) })
    schedule("m1")
    vi.advanceTimersByTime(50)
    schedule("m2")
    schedule("m3")
    vi.advanceTimersByTime(200)
    expect(writes).toEqual(["m3"]) // 200ms 窗口内合并为一次尾随写,内容为最新状态
    schedule("m4")
    vi.advanceTimersByTime(200)
    expect(writes).toEqual(["m3", "m4"])
    vi.useRealTimers()
  })

  test("flush() forces the pending write immediately", async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const schedule = createPersistScheduler(200, async (tag) => { writes.push(tag) })
    schedule("m1")
    schedule.flush()
    expect(writes).toEqual(["m1"])
    vi.advanceTimersByTime(200)
    expect(writes).toEqual(["m1"]) // flush 后定时器不再重复写
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/sdk && bun test src/agent-persist.test.ts`
Expected: FAIL — `createPersistScheduler` 未定义

- [ ] **Step 3: 实现**

新文件 `packages/sdk/src/persist-scheduler.ts`:

```ts
export interface PersistScheduler {
  schedule: () => void
  flush: () => void
  cancel: () => void
}

// Trailing debounce: collapses bursts of message events into one write.
// Crash window is bounded by delayMs; run-final finally flush remains the backstop.
export function createPersistScheduler(
  delayMs: number,
  write: () => Promise<unknown>,
): PersistScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false
  const fire = () => {
    timer = null
    if (!pending) return
    pending = false
    void write()
  }
  return {
    schedule: () => {
      pending = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, delayMs)
    },
    flush: () => {
      if (timer) clearTimeout(timer)
      fire()
    },
    cancel: () => {
      if (timer) clearTimeout(timer)
      timer = null
      pending = false
    },
  }
}
```

`agent.ts` runSinglePrompt 中接线:

```ts
// runSinglePrompt 开头(创建 abortCtrl 之后):
const persistScheduler = createPersistScheduler(200, () =>
  this.persistCurrentSession(cwd, opts).then(() => undefined))
```

在事件循环里每处 `this.sessionMessages.push(...)` 之后(assistant/tool_result/system 三个分支,约 1068-1090)加一行:

```ts
persistScheduler.schedule()
```

`finally` 块(1097-1108)开头加 `persistScheduler.flush()`(兜底在 run 结束前把最后窗口写盘;随后的 `persistCurrentSession` 保持不变)。

修正 Step 1 测试以匹配实际签名(`schedule` 无参、write 闭包捕获状态)——测试里 `schedule("m1")` 改为闭包计数:

```ts
let latest = ""
const schedule = createPersistScheduler(200, async () => { writes.push(latest) })
latest = "m1"; schedule()
latest = "m2"; schedule()
latest = "m3"; schedule()
vi.advanceTimersByTime(200)
expect(writes).toEqual(["m3"])
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/sdk && bun test src/agent-persist.test.ts && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/persist-scheduler.ts packages/sdk/src/persist-scheduler.test.ts packages/sdk/src/agent.ts packages/sdk/src/agent-persist.test.ts
git commit -m "✨ feat(sdk): message-level throttled session persistence"
```

(若把 Step 1 测试并入 `persist-scheduler.test.ts`,相应调整 add 路径。)

---

### Task 4: 软 abort(保留结果 + 补 error tool_result + 断点事件)

**Files:**
- Modify: `packages/sdk/src/engine.ts`(executeTools ~1583-1611;主循环 abort 触点 1041/1113/1214)
- Modify: `packages/sdk/src/types.ts`(断点事件类型)
- Test: `packages/sdk/src/engine-abort.test.ts`(新建)

**Interfaces:**
- Consumes: `onAsyncEvent` 回调(QueryEngineConfig 已有,engine 内已有调用点)
- Produces: abort 后 engine 正常结束(不 throw);`onAsyncEvent` 收到 `{ type: 'system', subtype: 'run_aborted', pending_tool_calls: [{ id, name, input }] }`(Task 6 消费);session history 中无悬空 tool_use

- [ ] **Step 1: 写失败测试**

```ts
// packages/sdk/src/engine-abort.test.ts
import { describe, expect, test } from "bun:test"
import { QueryEngine } from "./engine.js"
import { StaticProvider } from "./providers/static.js" // 路径参考 engine.test.ts 实际 import

const tool = (name: string, opts: { slow?: boolean } = {}) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  isReadOnly: () => !opts.slow,
  async call() {
    if (opts.slow) await new Promise((r) => setTimeout(r, 10_000))
    return { type: "tool_result" as const, tool_use_id: "", content: `${name} done` }
  },
})

describe("soft abort semantics", () => {
  test("abort keeps completed tool results and fills interrupted placeholders", async () => {
    const provider = new StaticProvider([{
      content: [
        { type: "tool_use", id: "fast", name: "Read", input: {} },
        { type: "tool_use", id: "slow", name: "Bash", input: {} },
      ],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])

    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [tool("Read"), tool("Bash", { slow: true })],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
    })

    const events: any[] = []
    const abort = new AbortController()
    ;(engine as any).config.abortSignal = abort.signal
    const collecting = (async () => {
      for await (const event of engine.submitMessage("run")) events.push(event)
    })()

    // 等 fast 工具结果出现后(它先完成),在 slow 执行期间 abort
    await new Promise((r) => setTimeout(r, 50))
    abort.abort("interrupt")
    await collecting

    const toolResults = events.filter((e) => e.type === "tool_result").map((e) => e.result)
    const byId = Object.fromEntries(toolResults.map((r: any) => [r.tool_use_id, r]))
    expect(byId.fast).toBeTruthy()          // 已完成:结果保留
    expect(byId.slow?.is_error).toBe(true)  // 未完成:interrupted 占位
    expect(engine.getMessages().at(-1)?.role).toBe("user") // tool_result 已 push,无悬空
  })

  test("emits run_aborted async event with pending tool calls", async () => {
    const provider = new StaticProvider([{
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }],
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    }])
    const asyncEvents: any[] = []
    const engine = new QueryEngine({
      cwd: process.cwd(),
      model: "test-model",
      provider,
      tools: [tool("Bash", { slow: true })],
      systemPrompt: "test",
      maxTurns: 3,
      maxTokens: 256,
      includePartialMessages: false,
      canUseTool: async () => ({ behavior: "allow" }),
      onAsyncEvent: (event) => asyncEvents.push(event),
    })
    const abort = new AbortController()
    ;(engine as any).config.abortSignal = abort.signal
    const collecting = (async () => {
      for await (const event of engine.submitMessage("run")) { /* drain */ }
    })()
    await new Promise((r) => setTimeout(r, 50))
    abort.abort("interrupt")
    await collecting

    const aborted = asyncEvents.find((e) => e.subtype === "run_aborted")
    expect(aborted?.pending_tool_calls).toEqual([
      { id: "t1", name: "Bash", input: { command: "x" } },
    ])
  })
})
```

(StaticProvider 的实际导入路径与构造方式以 `engine.test.ts` 现有用法为准;若其不支持 abort 感知,abort 测试可能需要一个 provider 包装——参考现有测试的模式调整,目标语义不变。)

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/sdk && bun test src/engine-abort.test.ts`
Expected: FAIL — abort 后 throw,事件流中断,无 run_aborted 事件

- [ ] **Step 3: 实现**

**(a) executeTools 软化**(engine.ts:1583-1611)。替换并发与串行段的 abort 检查:

```ts
const interruptedResult = (block: ToolUseBlock) => ({
  type: 'tool_result' as const,
  tool_use_id: block.id,
  content: 'Error: interrupted by user before execution',
  is_error: true,
  tool_name: block.name,
})

// Execute concurrent tools (batched by MAX_CONCURRENCY)
for (let i = 0; i < concurrent.length; i += MAX_CONCURRENCY) {
  if (this.config.abortSignal?.aborted) break // soft: skip not-yet-started batches
  const batch = concurrent.slice(i, i + MAX_CONCURRENCY)
  const batchResults = await Promise.allSettled(
    batch.map((item) => this.executeSingleTool(item.block, item.tool, context)),
  )
  for (const [batchIndex, settled] of batchResults.entries()) {
    const item = batch[batchIndex]
    if (!item) continue
    // Settled-but-rejected (aborted mid-flight) becomes an interrupted placeholder;
    // fulfilled results are kept even if the signal aborted while awaiting.
    const batchResult = settled.status === 'fulfilled'
      ? settled.value
      : { result: interruptedResult(item.block), events: [] as any[], toolsUsed: [] as string[] }
    results[item.index] = batchResult.result
    events.push(...batchResult.events)
    toolsUsed.push(...batchResult.toolsUsed)
  }
}

for (const item of serial) {
  if (this.config.abortSignal?.aborted) break // soft: skip remaining serial tools
  let result
  try {
    result = await this.executeSingleTool(item.block, item.tool, context)
  } catch {
    result = { result: interruptedResult(item.block), events: [] as any[], toolsUsed: [] as string[] }
  }
  results[item.index] = result.result
  events.push(...result.events)
  toolsUsed.push(...result.toolsUsed)
}
```

末尾 fallback(1613-1622)已有兜底(为无 result 的 block 填 error)——abort 跳过的工具靠它或显式 `interruptedResult` 填充;确保每个 block 都有 result。

**(b) 主循环软化**(engine.ts:1041/1113/1214-1215)。把 `throw new Error('aborted')` 改为记录中断并 break:

```ts
if (this.config.abortSignal?.aborted) {
  aborted = true
  // fall through to normal turn finalization, then break the outer loop
}
```

具体:在 agentic loop 的三个 abort 检查点,设局部 `let aborted = false`;检查点处置 `aborted = true` 并跳过后续 LLM 请求(不发起下一轮 `withRetry`),走正常收尾路径(result 事件、messages 已包含补齐的 tool_result),循环 break。`executeTools` 返回后即使 `aborted` 也要把 tool_result 消息 push 进 `this.messages`(保持配对)。

**(c) 断点事件**。收尾处(aborted === true 时):

```ts
this.config.onAsyncEvent?.({
  type: 'system',
  subtype: 'run_aborted',
  pending_tool_calls: abortedPendingToolCalls, // 未开始/被中断的 block: { id, name, input }
  session_id: this.sessionId,
} as any)
```

`abortedPendingToolCalls` 在 executeTools 中收集(被 break 跳过与 catch 转占位的 block)并随返回值带出——给 `executeTools` 的返回值加 `pendingToolCalls?: ToolUseBlock[]` 字段,或改为在 engine 实例上暂存 `this.abortedPendingToolCalls`。取实例暂存(改动小)。

**(d) 类型**。types.ts 的 system 事件联合(找到 SystemMessage 定义处)扩展可选字段:

```ts
subtype?: 'run_aborted'
pending_tool_calls?: Array<{ id: string; name: string; input: unknown }>
```

以现有 SystemMessage 结构为准做最小扩展。

- [ ] **Step 4: 运行确认通过 + 回归**

Run: `cd packages/sdk && bun test src/engine-abort.test.ts && bun test`
Expected: PASS;现有 abort 相关测试(若有)行为变化需逐一核对——旧测试若断言 `throw`,按新语义更新并在 commit message 注明行为变更

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/engine.ts packages/sdk/src/types.ts packages/sdk/src/engine-abort.test.ts
git commit -m "✨ feat(sdk): soft abort — keep completed results, fill placeholders, emit run_aborted"
```

---

### Task 5: Agent.resumeInterruptedRun / discardInterruptedRun

**Files:**
- Modify: `packages/sdk/src/agent.ts`(新方法,放在 `interrupt()` 附近)
- Test: `packages/sdk/src/agent-resume.test.ts`(新建)

**Interfaces:**
- Consumes: `detectDanglingToolUses`(Task 1)、`toolContinuations`(Task 2)、Agent 现有 `runSinglePrompt`
- Produces: `Agent.resumeInterruptedRun(): AsyncGenerator<SDKMessage>`、`Agent.discardInterruptedRun(): Promise<void>`(Task 7 sidecar 消费);工具副作用判定用 `ToolDefinition.isReadOnly`(engine 分区同款判断,取 `this.cfg` 解析后的 tools——与 `runSinglePrompt` 里 `tools` 的来源一致,实现时复用同一获取函数)

- [ ] **Step 1: 写失败测试**

```ts
// packages/sdk/src/agent-resume.test.ts
import { describe, expect, test } from "bun:test"
// Agent 构造依赖较多;测试策略:mock provider + 最小 opts(参考 packages/sdk 现有 agent 级测试的构造方式;
// 若无先例,提取 resume 的核心决策为纯函数 buildResumeContinuations 并直接测它):

import { buildResumeContinuations } from "./interrupt-recovery.js"

describe("buildResumeContinuations", () => {
  const dangling = [
    { id: "r1", name: "Read", input: { path: "a" } },
    { id: "w1", name: "Edit", input: { path: "b" } },
  ]

  test("read-only tools replay; side-effect tools get interrupted placeholder", () => {
    const isReadOnly = (name: string) => name === "Read"
    const continuations = buildResumeContinuations(dangling, { isReadOnly })
    expect(continuations).toEqual([
      { toolCall: { id: "r1", name: "Read", input: { path: "a" } } },
      {
        toolCall: { id: "w1", name: "Edit", input: { path: "b" } },
        toolResult: {
          type: "tool_result",
          tool_use_id: "w1",
          content: "Error: interrupted before completion; actual state unknown — inspect the workspace before retrying.",
          is_error: true,
        },
      },
    ])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/sdk && bun test src/agent-resume.test.ts`
Expected: FAIL — `buildResumeContinuations` 未定义

- [ ] **Step 3: 实现**

`interrupt-recovery.ts` 追加:

```ts
import type { PersistedToolContinuation } from './types.js'

export function buildResumeContinuations(
  dangling: DanglingToolUse[],
  toolInfo: { isReadOnly: (toolName: string) => boolean },
): PersistedToolContinuation[] {
  return dangling.map((use) =>
    toolInfo.isReadOnly(use.name)
      ? { toolCall: { id: use.id, name: use.name, input: use.input } }
      : {
          toolCall: { id: use.id, name: use.name, input: use.input },
          toolResult: {
            type: 'tool_result' as const,
            tool_use_id: use.id,
            content:
              'Error: interrupted before completion; actual state unknown — inspect the workspace before retrying.',
            is_error: true,
          },
        },
  )
}
```

`agent.ts` 新方法(放在 `interrupt()` 后):

```ts
/**
 * Resume an interrupted run from the persisted dangling tool boundary.
 * Read-only tools replay once; side-effect tools get an interrupted
 * placeholder (sidecar-conservative: never auto-replay mutations).
 */
async *resumeInterruptedRun(overrides?: Partial<AgentOptions>): AsyncGenerator<SDKMessage, void> {
  if (this.abortCtrl) throw new Error('agent is running')
  const dangling = detectDanglingToolUses(this.history)
  if (dangling.length === 0) return
  await this.setupDone
  const opts = this.getEffectiveOptions(overrides)
  const tools = /* 与 runSinglePrompt 相同的 tools 解析(提取现有逻辑为私有 getRunTools(opts)) */
    []
  const knownNames = new Set(tools.map((t) => t.name))
  const continuations = buildResumeContinuations(dangling, {
    isReadOnly: (name) => {
      const tool = tools.find((t) => t.name === name)
      if (!tool || !knownNames.has(name)) return false // 未知工具视同副作用,不重放
      return tool.isReadOnly?.(undefined as any, undefined as any) === true
        || tool.isConcurrencySafe?.(undefined as any, undefined as any) === true
    },
  })
  yield* this.runSinglePrompt('', { ...overrides, toolContinuations: continuations })
}

/**
 * Discard an interrupted run: fill dangling tool_use with error results so
 * the session lands in a clean state without another model request.
 */
async discardInterruptedRun(cwd: string): Promise<void> {
  const dangling = detectDanglingToolUses(this.history)
  if (dangling.length === 0) return
  this.history.push({
    role: 'user',
    content: dangling.map((use) => ({
      type: 'tool_result' as const,
      tool_use_id: use.id,
      content: 'Error: run discarded by user',
      is_error: true,
    })),
  } as any)
  await this.persistCurrentSession(cwd, this.getEffectiveOptions())
}
```

(`runSinglePrompt` 已支持 `opts.toolContinuations` 时跳过 user prompt——agent.ts:959 的 `userMessage = ... || opts.toolContinuation` 分支在 Task 2 已改为数组判断;空 prompt 不会产生第二条用户消息。)

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/sdk && bun test src/agent-resume.test.ts && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/interrupt-recovery.ts packages/sdk/src/interrupt-recovery.test.ts packages/sdk/src/agent.ts packages/sdk/src/agent-resume.test.ts
git commit -m "✨ feat(sdk): resumeInterruptedRun / discardInterruptedRun entry points"
```

---

### Task 6: sidecar 捕获 abort 断点写入 RunContinuationStore

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts`(handleAsyncEvent ~1797)
- Modify: `apps/sidecar/src/services/agent-runtime/interruption/approval-service.ts`(导出 `classifyToolKind` / `hashToolInput`,approval-service.ts:204-214 现为私有)
- Test: `apps/sidecar/src/rpc/agent-handlers.runtime-state.test.ts`(追加,或新 test 文件参考同目录测试的构造方式)

**Interfaces:**
- Consumes: Task 4 的 `run_aborted` 事件(经 `onAsyncEvent: handleAsyncEvent` 已接入);`createFileBackedRunContinuationStore(sessionDir)`(run.ts:1800 已有用法);`RunContinuationState`(run-continuation.ts:34)
- Produces: abort 后 `runs/<runId>.continuation.json` 存在 `{ status: 'interrupted', checkpoint: { step: 'waiting_for_tool_result', toolCall, toolKind } }`(Task 7 查询消费)

- [ ] **Step 1: 写失败测试**

在 sidecar 现有 runtime-state 测试文件追加(构造方式参考文件内现有用例;核心断言):

```ts
test("run_aborted event persists an interrupted continuation checkpoint", async () => {
  // 参考 approval-service.test.ts 的 store 构造:临时 sessionDir + createFileBackedRunContinuationStore
  // 调用被测入口(将逻辑提取为可测函数 persistAbortContinuation,见 Step 3):
  await persistAbortContinuation({
    sessionDir,
    runId: "run-1",
    threadId: "thread-1",
    pendingToolCalls: [{ id: "t1", name: "Bash", input: { command: "ls" } }],
  })

  const store = createFileBackedRunContinuationStore(sessionDir)
  const state = await store.get("run-1")
  expect(state?.status).toBe("interrupted")
  expect(state?.version).toBe(2)
  expect(state?.checkpoint.step).toBe("waiting_for_tool_result")
  expect(state?.checkpoint.toolCall?.name).toBe("Bash")
  expect(state?.checkpoint.toolKind).toBe("execute")
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/sidecar && bun test src/rpc/agent-handlers.runtime-state.test.ts`
Expected: FAIL — `persistAbortContinuation` 未定义

- [ ] **Step 3: 实现**

新函数(放在 `apps/sidecar/src/services/agent-runtime/interruption/abort-continuation.ts`):

```ts
import { classifyToolKind, hashToolInput } from "./approval-service.js"; // Task 内先在 approval-service.ts:208/204 前加 export
import { createFileBackedRunContinuationStore } from "../runner/run-continuation-store.js";

export interface AbortContinuationInput {
  sessionDir: string;
  runId: string;
  threadId: string;
  pendingToolCalls: Array<{ id: string; name: string; input: unknown }>;
}

export async function persistAbortContinuation(input: AbortContinuationInput): Promise<void> {
  const pending = input.pendingToolCalls[0];
  if (!pending) return;
  const now = new Date().toISOString();
  const store = createFileBackedRunContinuationStore(input.sessionDir);
  // ponytail: checkpoint tracks the first pending tool only; multi-tool abort
  // boundaries fall back to SDK dangling detection on resume.
  const kind = classifyToolKind(pending.name);
  await store.upsert({
    version: 2,
    runId: input.runId,
    threadId: input.threadId,
    status: "interrupted",
    checkpoint: {
      step: "waiting_for_tool_result",
      toolCallId: pending.id,
      toolName: pending.name,
      toolKind: kind,
      toolCall: {
        id: pending.id,
        name: pending.name,
        input: pending.input,
        inputHash: hashToolInput(pending.input),
        kind,
      },
    },
    reason: "run aborted by user",
    createdAt: now,
    updatedAt: now,
  });
}
```

单一事实来源:`classifyToolKind`(approval-service.ts:208,read/glob/grep/processoutput/taskoutput→read,write/edit/notebookedit→write,askuserquestion→control,默认 execute)与 `hashToolInput`(approval-service.ts:204,sha256 of JSON)直接复用——本任务第一步是在 approval-service.ts 给这两个函数加 `export`,不复制实现。

`run.ts` handleAsyncEvent(在 task_notification 分支旁)追加:

```ts
if (event.type === "system" && (event as any).subtype === "run_aborted" && input.runId) {
  void persistAbortContinuation({
    sessionDir,
    runId: input.runId,
    threadId: input.threadId ?? "",
    pendingToolCalls: ((event as any).pending_tool_calls ?? []) as Array<{ id: string; name: string; input: unknown }>,
  }).catch((error) => {
    log.warn("Failed to persist abort continuation", {
      sessionId: input.lumeSessionId,
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
```

(`sessionDir`/`log`/`runId` 的取值方式对齐同函数内 task_notification 分支的现有写法。)

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/sidecar && bun test src/rpc/agent-handlers.runtime-state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/interruption/abort-continuation.ts apps/sidecar/src/services/agent-runtime/interruption/approval-service.ts apps/sidecar/src/services/agent-runtime/runtime-core/run.ts apps/sidecar/src/rpc/agent-handlers.runtime-state.test.ts
git commit -m "✨ feat(sidecar): persist abort continuation checkpoint on run_aborted"
```

---

### Task 7: sidecar 待恢复查询 + 悬空兜底 resume 入口

**Files:**
- Modify: `packages/shared/src/types/agent.ts`(IPC 通道常量,RESUME_RUN 旁 ~2089)
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`(新 handler + schemas)
- Modify: `apps/sidecar/src/rpc/schemas.ts`(输入校验)
- Test: `apps/sidecar/src/rpc/agent-handlers.test.ts`(追加)

**Interfaces:**
- Consumes: `runStateStore.listByThread`(agent-handlers.ts:405 已有用法)、`continuationStore.get`、Task 6 的 interrupted checkpoint、SDK `resumeInterruptedRun`
- Produces: IPC `agent:get-pending-resume` → `{ threadId, hasPendingResume, reason, runId? }`;desktop(Task 8)消费

- [ ] **Step 1: 写失败测试**

```ts
test("get-pending-resume reports interrupted runs", async () => {
  // 构造:临时 sessionDir,写入一个 status=interrupted 的 RunContinuationState 与对应 runState
  // 调用 handler(参考现有 resume-run 测试的调用方式)
  const result = await getPendingResume({ threadId: "thread-1" });
  expect(result.hasPendingResume).toBe(true);
  expect(result.runId).toBe("run-1");
  // 干净线程:
  const clean = await getPendingResume({ threadId: "thread-clean" });
  expect(clean.hasPendingResume).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/sidecar && bun test src/rpc/agent-handlers.test.ts`
Expected: FAIL — handler 未注册

- [ ] **Step 3: 实现**

1. `packages/shared/src/types/agent.ts`:

```ts
GET_PENDING_RESUME: 'agent:get-pending-resume',
```

2. `schemas.ts`:`getPendingResumeInputSchema = z.object({ threadId: z.string() })`(对齐文件内现有 schema 风格)。

3. `agent-handlers.ts`:

```ts
const getPendingResume = async (input: { threadId: string }): Promise<{
  hasPendingResume: boolean;
  runId?: string;
  reason?: string;
}> => {
  const sessionDir = resolveRuntimeSessionDir(input.threadId);
  const runStore = createFileBackedLumeRunStateStore(sessionDir);
  const continuationStore = createFileBackedRunContinuationStore(sessionDir);
  const runs = await runStore.listByThread(input.threadId);
  for (const run of runs.slice().reverse()) {
    const continuation = await continuationStore.get(run.runId);
    if (continuation && ["interrupted", "tool_running", "waiting_background"].includes(continuation.status)) {
      return { hasPendingResume: true, runId: run.runId, reason: continuation.reason };
    }
    break; // 只看最近一个 run
  }
  return { hasPendingResume: false };
};
```

并在 handler 注册表(784 行 resume-run 旁)注册:

```ts
AGENT_IPC_CHANNELS.GET_PENDING_RESUME: async (params: unknown) => {
  const input = validateInput(getPendingResumeInputSchema, params, AGENT_IPC_CHANNELS.GET_PENDING_RESUME);
  return getPendingResume(input);
},
```

(`listByThread` 的返回字段名以 agent-handlers.ts:405 现有用法为准。)

4. **悬空兜底 resume**:`LumeResumeService.resumeRun` 的 `not_resumable` 分支之外,`resumeRunForThread` 在"找不到 continuation"时降级走 SDK 悬空兜底——通过 `sendAgentMessage` 发空续跑消息并携带 `messageMetadata.runtimeContinuation = { source: 'dangling-fallback' }`,`run.ts` 的 `resolvePersistedToolContinuation` 识别该标记时改调 Agent 的 `resumeInterruptedRun` 决策(或等价地由 run.ts 直接构造 `toolContinuations` 传入 AgentOptions——与 run.ts:2319 现有通路合并,优先选后者:在 `resolvePersistedToolContinuation` 返回 null 且标记为 dangling-fallback 时,由 agent history 悬空检测构造数组)。实现细节以 run.ts:2256 周边现有结构为准,验收标准:**无 checkpoint 的中断线程也能一键续跑,只读悬空重放、副作用悬空注入说明**。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/sidecar && bun test src/rpc/agent-handlers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/agent.ts apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/rpc/agent-handlers.ts apps/sidecar/src/rpc/agent-handlers.test.ts
git commit -m "✨ feat(sidecar): pending-resume query + dangling fallback resume"
```

---

### Task 8: desktop 恢复提示集成

**Files:**
- Modify: desktop 线程加载/会话打开组件(执行时定位:`grep -rn "resume-run\|RESUME_RUN" apps/desktop/src apps/web/src --include="*.ts" --include="*.tsx" | grep -v test` 找到 resume-run 的现有调用方,在其同层挂提示)
- Test: 组件测试参考 `AgentView.test.tsx` 模式(bun:test + fake DOM)

**Interfaces:**
- Consumes: IPC `agent:get-pending-resume`(Task 7)、现有 `agent:resume-run` 调用链、SDK `discardInterruptedRun`(经 sidecar 转发,若缺转发则在 Task 7 补 `agent:discard-interrupted-run` handler)
- Produces: 用户可见的恢复提示流

- [ ] **Step 1: 定位挂点**

Run: `grep -rn "RESUME_RUN\|resume-run" apps/desktop/src apps/web/src --include="*.ts" --include="*.tsx" | grep -v test | head`
以输出确定:线程选择/加载的组件文件、现有 resume 调用封装、UI 提示组件库的用法(base-ui)。

- [ ] **Step 2: 写失败测试**

在定位到的组件测试文件追加(伪代码骨架,以实际组件 API 为准):

```tsx
test("shows resume prompt when thread has pending resume", async () => {
  mockIpcCall("agent:get-pending-resume", { hasPendingResume: true, runId: "run-1" });
  render(<ThreadView threadId="t1" />);
  await screen.findByText(/上次有未完成任务/);
  fireEvent.click(screen.getByRole("button", { name: /继续/ }));
  expect(mockIpcCall).toHaveBeenCalledWith("agent:resume-run", expect.objectContaining({ threadId: "t1" }));
});
```

- [ ] **Step 3: 实现**

线程加载 effect 中查询 `get-pending-resume`;`hasPendingResume` 时渲染提示(文案:"上次有未完成任务,是否继续?" + [继续] [放弃] 按钮);[继续] 调现有 resume-run 封装;[放弃] 调 discard 通道并在完成后隐藏提示。样式对齐同文件现有提示/横幅组件,不新造设计。

- [ ] **Step 4: 运行确认通过 + 手动验证**

Run: `cd apps/desktop && bun test`(或该组件所属包的测试命令)
手动:制造一次中断(kill 进程或点停止)→ 重开会话 → 提示出现 → 续跑成功。

- [ ] **Step 5: Commit**

```bash
git add <定位到的文件>
git commit -m "✨ feat(desktop): pending-resume prompt on thread open"
```

---

## 任务依赖

```
Task 1 (悬空检测) ──┬──▶ Task 5 (resume/discard) ──▶ Task 7 (sidecar 兜底) ──▶ Task 8 (desktop)
Task 2 (数组化) ────┘
Task 3 (节流持久化) —— 独立,任意时点
Task 4 (软 abort) ──▶ Task 6 (sidecar 捕获) ──▶ Task 7
```

## 验收(整体)

1. `cd packages/sdk && bun test`、`cd apps/sidecar && bun test`、desktop 相关包测试全绿(main CI 有平台测试长期红的已知 baseline,对比判断)
2. 手动场景:run 中点停止 → session 无悬空(可继续对话);kill 进程 → 重开 → 提示恢复 → 续跑;副作用工具中断后不自动重放
3. typecheck:`bun run typecheck` 或各包等价命令通过
