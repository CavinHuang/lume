# Agent 灵动岛 Phase 2（macOS 26 原生刘海）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 macOS 26+ 用原生 NSPanel + SwiftUI 渲染灵动岛（贴刘海），与 Phase 1 的 Electron 透明窗共用同一份 `AgentIslandState`；macOS<26 / 非 macOS 回退 Electron 窗（Phase 1 已实现）。

**Architecture:** 方案 A 的原生分支——`apps/desktop` 主进程 service 推送同一快照给两条消费者：Electron 岛屿窗（既有）+ Swift helper（stdio JSONL）。新增 `macos-version.ts` 门控、`mac-agent-island-native-host.ts`（spawn/JSONL/4s 超时回退）、`packages/natives/agent-island/macos-agent-island-helper.swift`。Swift 侧零业务状态，只渲染快照 + 回传 intent。

**Tech Stack:** TypeScript（Node child_process）、Swift 5（AppKit NSPanel + SwiftUI + Codable）、JSON Lines over stdio、`bun:test`。

**参考实现:** Proma `D:\workspace\projects\ai-projects\Proma\apps\electron\native\agent-island\macos-agent-island-helper.swift` + `src/main/lib/mac-agent-island-native-host.ts` + `scripts/build-agent-island-native.ts`。Lume 版去除 planQuota（Lume 无额度）、类型对齐 Lume `AgentIslandState`。

---

## Global Constraints

- **平台门控**：macOS 26 = Darwin 主版本 `25`（`os.release()`）。`isMacOS26OrLater()` 仅在 `process.platform==='darwin'` 且 Darwin≥25 为真。
- **可测边界（如实记录）**：Task 1–5（TS + 协议）在 **Windows 可写可测**；Task 6–7（Swift 编译、NSPanel、真实 spawn 联调）**仅 macOS 可验证**。Windows 开发机对 Swift 代码只能写、不能编译/运行。
- **类型真源**：`packages/shared/src/types/agent-island.ts` 已定义 Lume 的 `AgentIslandState`（字段：`presentation / primarySessionId / compactLabel / sessions[threadId] / planning[todos,reminders] / updatedAt`）。Phase 2 的 `NativeAgentIslandSnapshot` 复用它，**不另造字段**。Lume **无** Proma 的 `pill / recentSessions / idleDashboard / planQuotas / visible / hovered / expanded`。
- **apps/desktop import 约定**：`apps/desktop/src/**` **不解析 `@lume/shared` 别名**，引用 shared 类型用相对路径 `../../../packages/shared/src/types/agent-island`（沿用 main.ts 既有约定）。
- **intent 归并**：Swift 回传的 `intent` 与 Electron renderer 的 `intent` 走**同一组 handler**（service.handleIntent），不重复实现。
- **IPC 双副本**：本 Phase 不新增 IPC 通道（native 走 stdio，不经 preload）；若因路由需要新增 invoke，必须同时加到 `preload.ts` + `electron-security.ts`。
- **提交策略**：按主题 5–7 commit、emoji 前缀；**仅在用户明确要求时提交**，每步以"测试通过 / 编译说明"为完成判据。
- **resources 路径**：helper 二进制 dev 落 `apps/desktop/resources/agent-island/macos-agent-island-helper`，packaged 读 `process.resourcesPath`。

---

## File Structure

**新建：**
- `apps/desktop/src/macos-version.ts` — `isMacOS26OrLater()` / `isMacOS26NativeIslandCapable()`
- `apps/desktop/src/mac-agent-island-native-host.ts` — spawn helper + JSONL + 4s 超时回退
- `packages/natives/agent-island/macos-agent-island-helper.swift` — NSPanel + SwiftUI（macOS only）
- `apps/desktop/scripts/build-agent-island-native.ts` — `xcrun swiftc` 构建（macOS only，非 macOS skip）

**修改：**
- `packages/shared/src/types/agent-island.ts` — 追加 `NativeAgentIslandSnapshot` / `NativeAgentIslandEvent` + native intent 类型
- `apps/desktop/src/agent-island-service.ts` — `pushState()` 同时 publish 给 native host；注入 `publishNative` 回调
- `apps/desktop/src/main.ts` — `startAgentIslandSurface()` 路由（macOS26→native 优先，超时/失败→Electron 窗）；native intent 接到 `handleIntent`

> **职责边界**：`macos-version.ts`（纯门控，可测）↔ `mac-agent-island-native-host.ts`（spawn/stdio 壳，依赖版本门控）↔ `agent-island-service.ts`（状态真源，同时推 Electron + native）↔ Swift helper（只渲染收到的快照）。

---

## Task 1: macOS 版本门控（Windows 可测）

**Files:**
- Create: `apps/desktop/src/macos-version.ts`
- Test: `apps/desktop/src/macos-version.test.ts`

**Interfaces:**
- Produces: `isMacOS26OrLater(darwinRelease?): boolean`、`isMacOS26NativeIslandCapable(platform?, darwinRelease?): boolean`

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/macos-version.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import { isMacOS26OrLater, isMacOS26NativeIslandCapable } from './macos-version'

describe('macos-version', () => {
  test('Darwin 25 (macOS 26) 及以上为真', () => {
    expect(isMacOS26OrLater('25.0.0')).toBe(true)
    expect(isMacOS26OrLater('26.1.0')).toBe(true)
    expect(isMacOS26OrLater('24.0.0')).toBe(false) // macOS 15
  })
  test('非法 release 为假', () => {
    expect(isMacOS26OrLater('')).toBe(false)
    expect(isMacOS26OrLater('abc')).toBe(false)
  })
  test('native island 仅 macOS 26+ 可用；非 darwin 恒假', () => {
    expect(isMacOS26NativeIslandCapable('darwin', '25.0.0')).toBe(true)
    expect(isMacOS26NativeIslandCapable('darwin', '24.0.0')).toBe(false)
    expect(isMacOS26NativeIslandCapable('win32', '25.0.0')).toBe(false)
    expect(isMacOS26NativeIslandCapable('linux', '25.0.0')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/desktop/src/macos-version.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`apps/desktop/src/macos-version.ts`:
```ts
import { release } from 'node:os'

/** Apple 把 macOS 26 映射到 Darwin 25。后续 macOS 用更大 Darwin 主版本号。 */
const MACOS_26_DARWIN_MAJOR = 25

/** macOS 26+（Liquid Glass 菜单栏处理）才支持原生灵动岛面板。 */
export function isMacOS26OrLater(darwinRelease: string = release()): boolean {
  const darwinMajor = Number.parseInt(darwinRelease.split('.')[0] ?? '', 10)
  return Number.isFinite(darwinMajor) && darwinMajor >= MACOS_26_DARWIN_MAJOR
}

/** 原生灵动岛仅在 macOS 26+ 启用；其他平台走 Electron 透明窗回退。 */
export function isMacOS26NativeIslandCapable(
  platform: string = process.platform,
  darwinRelease: string = release(),
): boolean {
  return platform === 'darwin' && isMacOS26OrLater(darwinRelease)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/desktop/src/macos-version.test.ts`
Expected: PASS（3 test）

- [ ] **Step 5: 不单独提交（与 Task 3 一起作为 native host 主题提交）**

---

## Task 2: JSONL 协议类型（Windows 可测）

**Files:**
- Modify: `packages/shared/src/types/agent-island.ts`（追加 native 类型）
- Test: `packages/shared/src/types/agent-island-native.contract.test.ts`

**Interfaces:**
- Consumes: `AgentIslandState`（已存在于同文件）、`AgentIslandIntentName`
- Produces: `NativeAgentIslandSnapshot`（main→Swift）、`NativeAgentIslandEvent`（Swift→main）

- [ ] **Step 1: 写契约测**

`packages/shared/src/types/agent-island-native.contract.test.ts`:
```ts
import { describe, expect, test } from 'bun:test'
import type {
  NativeAgentIslandSnapshot,
  NativeAgentIslandEvent,
  AgentIslandState,
} from './agent-island'

describe('agent-island native JSONL 协议', () => {
  test('NativeAgentIslandSnapshot 可 JSON round-trip', () => {
    const state: AgentIslandState = {
      presentation: 'compact',
      primarySessionId: 't1',
      compactLabel: 'Lume · 正在执行',
      sessions: [{
        threadId: 't1', title: '任务A', phase: 'running',
        detail: '第 1 步 · ls', activityLines: ['ls'],
        attention: false, unread: false, terminalAt: null, lastActivityAt: 1,
      }],
      planning: { todos: [], reminders: [] },
      updatedAt: 1,
    }
    const snap: NativeAgentIslandSnapshot = {
      type: 'snapshot', protocol: 1, revision: 1, state,
    }
    const round = JSON.parse(JSON.stringify(snap)) as NativeAgentIslandSnapshot
    expect(round.type).toBe('snapshot')
    expect(round.protocol).toBe(1)
    expect(round.state.sessions[0].threadId).toBe('t1')
    // Lume 无 planQuotas 字段
    expect('planQuotas' in round).toBe(false)
  })

  test('NativeAgentIslandEvent ready/fatal/intent 形状', () => {
    const ready: NativeAgentIslandEvent = { type: 'ready', protocol: 1 }
    const fatal: NativeAgentIslandEvent = { type: 'fatal', message: 'boom' }
    const intent: NativeAgentIslandEvent = { type: 'intent', name: 'open-session', threadId: 't1' }
    expect(JSON.parse(JSON.stringify(ready)).type).toBe('ready')
    expect(JSON.parse(JSON.stringify(fatal)).message).toBe('boom')
    expect(JSON.parse(JSON.stringify(intent)).threadId).toBe('t1')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/shared/src/types/agent-island-native.contract.test.ts`
Expected: FAIL（类型未导出）

- [ ] **Step 3: 追加实现到 `packages/shared/src/types/agent-island.ts` 末尾**

```ts
// ────────────────────────────────────────────────────────────
// Phase 2：原生 macOS helper 的 JSONL 协议（main ↔ Swift）
// ────────────────────────────────────────────────────────────

/** 主进程 → Swift helper 的 JSONL 全量状态。Lume 无 planQuotas。 */
export interface NativeAgentIslandSnapshot {
  type: 'snapshot'
  protocol: 1
  /** 单调递增；Swift 据此丢弃乱序/重复快照。 */
  revision: number
  state: AgentIslandState
}

/** Swift helper → 主进程的受限事件。intent 与 Electron renderer 共用 AgentIslandIntentName。 */
export type NativeAgentIslandEvent =
  | { type: 'ready'; protocol: 1 }
  | { type: 'fatal'; message: string }
  | { type: 'intent'; name: 'set-expanded'; value: boolean }
  | { type: 'intent'; name: 'set-hovered'; value: boolean }
  | { type: 'intent'; name: 'open-main' }
  | { type: 'intent'; name: 'open-session'; threadId: string }
  | { type: 'intent'; name: 'open-planning' }
  | { type: 'intent'; name: 'dismiss' }

/** native intent → service 能理解的形状（与 renderer intent 归并到同一 handler）。 */
export function nativeEventToIntent(event: Extract<NativeAgentIslandEvent, { type: 'intent' }>): {
  name: AgentIslandIntentName
  value?: boolean
  threadId?: string
} {
  switch (event.name) {
    case 'set-expanded': return { name: 'set-expanded', value: event.value }
    case 'set-hovered': return { name: 'set-hovered', value: event.value }
    case 'open-session': return { name: 'open-session', threadId: event.threadId }
    case 'open-main': return { name: 'open-main' }
    case 'open-planning': return { name: 'open-main' }   // Lume 无独立 planning 窗，降级打开主窗
    case 'dismiss': return { name: 'dismiss' }
  }
}
```

> **注意**：`AgentIslandIntentName` 已含 `'set-hovered'`？核对既有类型——若缺，在 `AgentIslandIntentName` 联合里补 `'set-hovered'`，并在 `AgentIslandIntent` 接口确认 `value?: boolean` 已覆盖 hovered（既有 `value` 字段复用）。`open-planning` 在 Lume 无独立窗口，映射为 `open-main`（与 Phase 1 现状一致）。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/shared/src/types/agent-island-native.contract.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck**

Run: `bunx tsc --noEmit -p packages/shared/tsconfig.json`（路径以仓库实际为准）
Expected: 无新增错误

- [ ] **Step 6: 不单独提交（随 Task 3 主题）**

---

## Task 3: Native host（TS，spawn + JSONL + 超时回退）

**Files:**
- Create: `apps/desktop/src/mac-agent-island-native-host.ts`

**Interfaces:**
- Consumes: `NativeAgentIslandSnapshot` / `NativeAgentIslandEvent`（Task 2）、`isMacOS26NativeIslandCapable`（Task 1）
- Produces: `startMacAgentIslandNativeHost(opts)` / `publishMacAgentIslandSnapshot(snap)` / `isMacAgentIslandNativeHostReady()` / `disposeMacAgentIslandNativeHost()`

- [ ] **Step 1: 写实现（基于 Proma，适配 Lume 类型 + intent 字段名）**

`apps/desktop/src/mac-agent-island-native-host.ts`:
```ts
import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeAgentIslandEvent, NativeAgentIslandSnapshot } from '../../../packages/shared/src/types/agent-island'

const PROTOCOL = 1
const READY_TIMEOUT_MS = 4_000

export interface MacAgentIslandNativeHostOptions {
  onReady: () => void
  onEvent: (event: NativeAgentIslandEvent) => void
  /** helper 缺失/协议不符/运行中退出时调用方应启用 Electron fallback。 */
  onUnavailable: (reason: string) => void
}

let child: ChildProcessWithoutNullStreams | null = null
let ready = false
let closing = false
let readyTimer: ReturnType<typeof setTimeout> | null = null
let stdoutBuffer = ''

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'agent-island', 'macos-agent-island-helper')
    : join(__dirname, 'resources', 'agent-island', 'macos-agent-island-helper')
}

function clearReadyTimer(): void {
  if (readyTimer) clearTimeout(readyTimer)
  readyTimer = null
}

function parseEvent(line: string): NativeAgentIslandEvent | null {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object') return null
    const e = value as Record<string, unknown>
    if (e.type === 'ready' && typeof e.protocol === 'number') return { type: 'ready', protocol: e.protocol as 1 }
    if (e.type === 'fatal' && typeof e.message === 'string') return { type: 'fatal', message: e.message }
    if (e.type !== 'intent' || typeof e.name !== 'string') return null
    // Lume 协议：set-expanded/set-hovered 用 value(boolean)；open-session 用 threadId
    if (e.name === 'set-expanded' && typeof e.value === 'boolean') return { type: 'intent', name: 'set-expanded', value: e.value }
    if (e.name === 'set-hovered' && typeof e.value === 'boolean') return { type: 'intent', name: 'set-hovered', value: e.value }
    if (e.name === 'open-session' && typeof e.threadId === 'string' && e.threadId.length > 0)
      return { type: 'intent', name: 'open-session', threadId: e.threadId }
    if (e.name === 'open-main' || e.name === 'open-planning' || e.name === 'dismiss')
      return { type: 'intent', name: e.name }
    return null
  } catch {
    return null
  }
}

function write(message: unknown): boolean {
  if (!child || child.killed || child.stdin.destroyed) return false
  try { child.stdin.write(`${JSON.stringify(message)}\n`); return true } catch { return false }
}

export function startMacAgentIslandNativeHost(options: MacAgentIslandNativeHostOptions): boolean {
  if (process.platform !== 'darwin') return false
  if (child && !child.killed) return true
  const path = helperPath()
  if (!existsSync(path)) { options.onUnavailable(`native helper missing: ${path}`); return false }

  closing = false; ready = false; stdoutBuffer = ''
  try {
    child = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], detached: false })
  } catch (error) {
    child = null
    options.onUnavailable(`failed to spawn: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }

  const current = child
  readyTimer = setTimeout(() => {
    if (current !== child || ready) return
    options.onUnavailable('native helper did not report ready before timeout')
    disposeMacAgentIslandNativeHost()
  }, READY_TIMEOUT_MS)

  current.stdout.setEncoding('utf8')
  current.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let newline = stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim()
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (line) {
        const event = parseEvent(line)
        if (event?.type === 'ready') {
          if (event.protocol !== PROTOCOL) {
            options.onUnavailable(`unsupported protocol: ${event.protocol}`)
            disposeMacAgentIslandNativeHost()
          } else if (!ready) {
            ready = true; clearReadyTimer(); options.onReady()
          }
        } else if (event?.type === 'fatal') {
          disposeMacAgentIslandNativeHost()
          options.onUnavailable(`native helper fatal: ${event.message}`)
        } else if (event) {
          options.onEvent(event)
        }
      }
      newline = stdoutBuffer.indexOf('\n')
    }
  })
  current.stderr.setEncoding('utf8')
  current.stderr.on('data', (chunk: string) => console.warn(`[agent-island:native] ${chunk.trim()}`))
  current.once('error', (error) => {
    if (current !== child || closing) return
    options.onUnavailable(`process error: ${error.message}`)
  })
  current.once('exit', (code, signal) => {
    if (current !== child) return
    const wasReady = ready
    child = null; ready = false; clearReadyTimer()
    if (!closing) options.onUnavailable(`exited (${wasReady ? 'after ready, ' : ''}code=${code ?? 'null'}, signal=${signal ?? 'none'})`)
  })
  return true
}

export function isMacAgentIslandNativeHostReady(): boolean {
  return ready && child !== null && !child.killed
}

export function publishMacAgentIslandSnapshot(snapshot: NativeAgentIslandSnapshot): boolean {
  if (!isMacAgentIslandNativeHostReady()) return false
  return write(snapshot)
}

export function disposeMacAgentIslandNativeHost(): void {
  closing = true; clearReadyTimer()
  const current = child
  if (!current || current.killed) { child = null; ready = false; stdoutBuffer = ''; return }
  const stdin = current.stdin
  if (stdin && !stdin.destroyed) {
    stdin.on('error', () => { /* helper 已退出，忽略 EPIPE */ })
    try { if (stdin.writable) stdin.write('{"type":"shutdown"}\n') } catch { /* closing */ }
    stdin.end()
  }
  child = null; ready = false; stdoutBuffer = ''
  const forceTimer = setTimeout(() => { if (!current.killed) current.kill('SIGTERM') }, 800)
  current.once('exit', () => clearTimeout(forceTimer))
}
```

> **与 Proma 的差异**：`(e as any).value` 替代 Proma 的 `expanded`/`hovered`（Lume 协议统一用 `value`）；`threadId` 替代 `sessionId`；去掉 `@proma/shared` 改相对路径 import。逻辑结构（超时/ready/fatal/exit/竞态 EPIPE）与 Proma 一致。

- [ ] **Step 2: typecheck（Windows 可做，spawn 路径不执行）**

Run: `bunx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: 无新增错误

- [ ] **Step 3: 提交（Task 1+2+3 native 协议层主题）**

```bash
git add apps/desktop/src/macos-version.ts apps/desktop/src/macos-version.test.ts \
        apps/desktop/src/mac-agent-island-native-host.ts \
        packages/shared/src/types/agent-island.ts \
        packages/shared/src/types/agent-island-native.contract.test.ts
git commit -m "✨ feat(desktop,shared): Agent 灵动岛 macOS 原生 host 与 JSONL 协议(Phase 2 骨架)"
```

---

## Task 4: service 推送 native + intent 归并（Windows 可改，逻辑可推断）

**Files:**
- Modify: `apps/desktop/src/agent-island-service.ts`

**Interfaces:**
- Consumes: `publishMacAgentIslandSnapshot` / `isMacAgentIslandNativeHostReady`（Task 3）、`nativeEventToIntent`（Task 2）
- Produces: service 同时推 Electron 窗口 + native host；`handleIntent` 仍是单一入口

- [ ] **Step 1: 定位现有推送点**

`agent-island-service.ts:251` 当前：`win.webContents.send('lume:event:agent:island:state', { state })`。在其推送方法（通常名 `pushState` / `broadcast`）内，Electron 发送之后/之外，增加 native publish。

- [ ] **Step 2: 注入 native publish 回调（构造参数）**

在 service 构造选项（`AgentIslandServiceOptions`）增加可选回调，避免 service 硬依赖 host 模块：
```ts
export interface AgentIslandServiceOptions {
  // ...既有字段...
  /** Phase 2：若 native host ready，同步推送快照；否则忽略。 */
  publishNativeSnapshot?: (snapshot: NativeAgentIslandSnapshot) => void
  isNativeReady?: () => boolean
}
```
import 类型：`import type { NativeAgentIslandSnapshot } from '../../../packages/shared/src/types/agent-island'`

- [ ] **Step 3: 在推送方法里加 native 分支**

在 `win.webContents.send(...)` 之后（或 `win` 为 null 时也推 native），加：
```ts
if (this.opts.isNativeReady?.()) {
  this.opts.publishNativeSnapshot?.({
    type: 'snapshot', protocol: 1,
    revision: this.revision++,     // service 维护单调 revision（若无则新增 private 字段）
    state,
  })
}
```
> `revision` 用于 Swift 丢弃乱序快照。若 service 无 revision 字段，新增 `private revision = 0` 并在此自增。

- [ ] **Step 4: intent handler 不变**

确认 `handleIntent(intent)` 是单一入口；Task 5 会把 native event 转成 intent 后也调它。无需在此修改。

- [ ] **Step 5: typecheck**

Run: `bunx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: 无新增错误（Windows 下 service 单测若依赖既有 fake，补一行 noop publishNative 即可）

- [ ] **Step 6: 不单独提交（随 Task 5 路由主题）**

---

## Task 5: 路由分流（main.ts）— native 优先 + 回退 Electron（Windows 可改）

**Files:**
- Modify: `apps/desktop/src/main.ts`

**Interfaces:**
- Consumes: `isMacOS26NativeIslandCapable`（Task 1）、`startMacAgentIslandNativeHost` / `disposeMacAgentIslandNativeHost`（Task 3）、`nativeEventToIntent`（Task 2）
- Produces: `startAgentIslandSurface()` / `stopAgentIslandSurface()`；native intent 接到 `getAgentIslandService().handleIntent`

- [ ] **Step 1: 新增路由函数（文件内，靠近 ensureIslandWindow ~1294）**

```ts
import { isMacOS26NativeIslandCapable } from './macos-version'
import {
  startMacAgentIslandNativeHost, disposeMacAgentIslandNativeHost,
  isMacAgentIslandNativeHostReady, publishMacAgentIslandSnapshot,
} from './mac-agent-island-native-host'
import { nativeEventToIntent } from '../../../packages/shared/src/types/agent-island'
import type { NativeAgentIslandSnapshot } from '../../../packages/shared/src/types/agent-island'

let nativeSurfaceActive = false

/** Phase 2：macOS 26+ 优先起 native 面；4s 未 ready / fatal / exit 则回退 Electron 窗。 */
function startAgentIslandSurface(): void {
  if (!isMacOS26NativeIslandCapable()) {
    ensureIslandWindow()          // 非 macOS 26：直接 Electron 窗（Phase 1 路径）
    return
  }
  const started = startMacAgentIslandNativeHost({
    onReady: () => { nativeSurfaceActive = true; destroyIslandWindow() }, // 用原生面，不建 BrowserWindow
    onEvent: (event) => {
      if (event.type === 'intent') {
        agentIslandService?.handleIntent(nativeEventToIntent(event))
      }
    },
    onUnavailable: (_reason) => {
      nativeSurfaceActive = false
      ensureIslandWindow()        // 回退 Electron 窗
    },
  })
  if (!started) ensureIslandWindow() // spawn 立即失败也回退
}

function stopAgentIslandSurface(): void {
  disposeMacAgentIslandNativeHost()
  nativeSurfaceActive = false
  destroyIslandWindow()
}
```

- [ ] **Step 2: 把 service 的 native 回调接到 host**

在 `getAgentIslandService()`（~1323）构造 service 时，补：
```ts
agentIslandService = new AgentIslandService({
  // ...既有字段...
  isNativeReady: () => nativeSurfaceActive && isMacAgentIslandNativeHostReady(),
  publishNativeSnapshot: (snap: NativeAgentIslandSnapshot) => publishMacAgentIslandSnapshot(snap),
})
```

- [ ] **Step 3: 替换既有启动/销毁接线点**

把 Phase 1 里"按需 ensureIslandWindow"的入口（settings.agentIsland.enabled 翻真、首次 push）改为调 `startAgentIslandSurface()`；`enabled===false` 与 app quit 处调 `stopAgentIslandSurface()`。定位点：`main.ts:2519`（enabled 检测）、quit/dispose 接线（搜 `destroyIslandWindow` 调用处）。

- [ ] **Step 4: typecheck**

Run: `bunx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: 无新增错误

- [ ] **Step 5: 提交（Task 4+5 路由主题）**

```bash
git add apps/desktop/src/main.ts apps/desktop/src/agent-island-service.ts
git commit -m "✨ feat(desktop): 灵动岛渲染面路由(macOS26 原生优先,4s 超时回退 Electron 窗)"
```

---

## Task 6: Swift helper（macOS only — 需 xcrun swiftc 编译核对）

> **约束**：本 Task 仅 macOS 可编译/运行验证。Windows 开发机：写代码 + typecheck 对不到（Swift），不要试图 `swiftc`。Codable 字段名必须与 Task 2 的 `NativeAgentIslandSnapshot.state`（即 Lume `AgentIslandState`）**逐字段对齐**，否则 decode 静默失败。

**Files:**
- Create: `packages/natives/agent-island/macos-agent-island-helper.swift`

**参考**：Proma `apps/electron/native/agent-island/macos-agent-island-helper.swift`。Lume 版差异：① 去 `PlanQuota/CompactPlanQuota/PlanQuotaCarousel/CompactPlanQuotaBadge`；② `AgentState` 字段换成 Lume 的；③ session 用 `threadId`；④ planning 是 `{todos, reminders}`（同结构 `AgentIslandPlanningItem`）。

- [ ] **Step 1: 写 Codable structs（严格对齐 Lume 类型）**

文件头 + structs（替换 Proma 的整套 quota/AgentState）：
```swift
import AppKit
import SwiftUI

private let expandedBottomCornerRadius: CGFloat = 32
private let expandedBottomCornerClearance: CGFloat = 32

// Lume AgentIslandSessionSnapshot（注意 threadId，非 sessionId）
struct AgentSession: Codable, Identifiable {
  let threadId: String
  let title: String
  let phase: String
  let interactionKind: String?
  let detail: String
  let activityLines: [String]
  let attention: Bool
  let unread: Bool
  let terminalAt: Double?
  let lastActivityAt: Double
  var id: String { threadId }
}

// Lume AgentIslandPlanningItem（todos 与 reminders 同结构）
struct PlanningItem: Codable, Identifiable {
  let id: String
  let title: String
  let kind: String        // "todo" | "calendar_event"
  let dueAt: Double
  let overdue: Bool
}

struct PlanningSnapshot: Codable {
  let todos: [PlanningItem]
  let reminders: [PlanningItem]
}

// Lume AgentIslandState（无 pill/recentSessions/idleDashboard/planQuotas/visible/hovered/expanded）
struct AgentState: Codable {
  let presentation: String   // "hidden" | "compact" | "expanded"
  let primarySessionId: String?
  let compactLabel: String
  let sessions: [AgentSession]
  let planning: PlanningSnapshot
  let updatedAt: Double
}

struct SnapshotMessage: Codable {
  let type: String
  let revision: Int
  let state: AgentState
  enum CodingKeys: String, CodingKey {
    case type, revision, state
    // protocol 字段 Swift 不需要（main 已校验），decode 时忽略多余字段即可
  }
}

struct ShutdownMessage: Codable { let type: String }
```

- [ ] **Step 2: NotchMetrics + 形状（沿用 Proma，无业务差异）**

直接照搬 Proma 的 `NotchMetrics`（`auxiliaryTopLeftArea/Right` + `safeAreaInsets.top` 判刘海）、`NotchSurfaceShape`、`NotchSurfaceOutline`（Bézier 下圆角）。这三个与业务无关，是纯几何。

- [ ] **Step 3: Panel + HostingView + Model（沿用 Proma，改 snapshot 字段访问）**

照搬 Proma `AgentIslandPanel`（canBecomeKey=false）、`AgentIslandHostingView`（hover tracking + hitTest）、`IslandModel`。`IslandModel.apply` 里 `isInteractive = next.state.visible` 改为 `isInteractive = next.state.presentation != "hidden"`（Lume 用 presentation）。

- [ ] **Step 4: CompactIslandView（去 quota，用 compactLabel）**

```swift
struct CompactIslandView: View {
  let snapshot: SnapshotMessage
  let height: CGFloat
  let action: (String, [String: Any]) -> Void

  private var primarySession: AgentSession? { snapshot.state.sessions.first }

  var body: some View {
    Button(action: { action("set-expanded", ["value": true]) }) {
      HStack(spacing: 8) {
        if primarySession == nil {
          Image(systemName: "bell").font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.white.opacity(0.65)).frame(width: 14)
        }
        // Lume 主进程已算好 compactLabel（"Lume · 正在执行" 等），Swift 不再拼。
        Text(snapshot.state.compactLabel)
          .font(.system(size: 10.5, weight: .semibold)).lineLimit(1)
          .foregroundStyle(.white.opacity(0.92))
        Spacer(minLength: 6)
        Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
          .foregroundStyle(.white.opacity(0.46))
      }
      .padding(.horizontal, 14).frame(height: height).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}
```
> 与 Proma 差异：去掉 `CompactPlanQuotaBadge`、`planningIndicator` 改由 `compactLabel` 承担（Lume 主进程已投影）、`action("set-expanded", ["value": true])`（Lume 协议用 `value`）。

- [ ] **Step 5: ExpandedIslandView（去 quota 轮播，planning 用 todos+reminders）**

基于 Proma `ExpandedIslandView`，去掉 `PlanQuotaCarousel` 分支与 `compactPlanQuota`。会话行点击 `action("open-session", ["threadId": s.threadId])`。planning 区改为两列：`snapshot.state.planning.todos` 与 `snapshot.state.planning.reminders`（都用 `PlanningItem`，渲染 title + dueAt + overdue 红色）。header 标题用 `snapshot.state.compactLabel` 或按 `primarySession?.phase` 映射中文（`running→正在执行 / needs-interaction→需要你接手 / completed→任务完成 / error→执行出错`）。展开/收起手势 `action("set-expanded", ["value": false])`。

- [ ] **Step 6: IslandRootView + IslandController（沿用 Proma，presentation 驱动）**

照搬 Proma `IslandRootView`，但 `expanded` 判定从 `snapshot.state.expanded` 改为 `snapshot.state.presentation == "expanded"`；`hovered` 用 hosting view 的 `set-hovered` intent（Swift → main），不在 snapshot 里读。`IslandController.layout` 里 `expanded = message.state.presentation == "expanded"`；`ignoresMouseEvents = message.state.presentation == "hidden"`。

- [ ] **Step 7: emitJson + emitIntent + @main（stdin JSONL 循环）**

```swift
func emitJson(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
        let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func emitIntent(_ name: String, _ values: [String: Any]) {
  var payload: [String: Any] = ["type": "intent", "name": name]
  values.forEach { payload[$0.key] = $0.value }
  emitJson(payload)
}

@main @MainActor
struct LumeAgentIslandHost {
  static func main() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let controller = IslandController()
    emitJson(["type": "ready", "protocol": 1])
    DispatchQueue.global(qos: .userInitiated).async {
      while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let type = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String
        else { continue }
        if type == "shutdown" {
          DispatchQueue.main.async { controller.close(); app.terminate(nil) }; return
        }
        if type == "snapshot", let message = try? JSONDecoder().decode(SnapshotMessage.self, from: data) {
          DispatchQueue.main.async { controller.apply(message) }
        }
      }
      DispatchQueue.main.async { controller.close(); app.terminate(nil) }
    }
    app.run()
  }
}
```

- [ ] **Step 8: macOS 编译验证（仅 macOS）**

Run（macOS）: `xcrun swiftc -O -parse-as-library packages/natives/agent-island/macos-agent-island-helper.swift -o /tmp/helper && echo OK`
Expected: 编译通过。Windows: **跳过，标注"待 macOS 验证"**。

- [ ] **Step 9: 提交**

```bash
git add packages/natives/agent-island/macos-agent-island-helper.swift
git commit -m "✨ feat(natives): Agent 灵动岛 macOS 原生 helper(NSPanel+SwiftUI,Phase 2)"
```

---

## Task 7: 构建脚本 + resources 打包（macOS build only）

**Files:**
- Create: `apps/desktop/scripts/build-agent-island-native.ts`
- Modify: `apps/desktop/package.json`（build 钩子 + electron-builder extraResources）

- [ ] **Step 1: 写构建脚本（基于 Proma）**

`apps/desktop/scripts/build-agent-island-native.ts`:
```ts
#!/usr/bin/env bun
/** 构建 macOS 原生灵动岛 helper（universal）。非 macOS skip。 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const source = resolve(appDir, '../../packages/natives/agent-island/macos-agent-island-helper.swift')
const output = resolve(appDir, 'resources/agent-island/macos-agent-island-helper')

if (process.platform !== 'darwin') {
  console.log('[agent-island-native] skipped (macOS only)')
  process.exit(0)
}
if (!existsSync(source)) throw new Error(`helper source not found: ${source}`)
mkdirSync(dirname(output), { recursive: true })
rmSync(output, { force: true })
// universal binary（arm64 + x86_64）
execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library',
  '-target', 'arm64-apple-macos26.0', source, '-o', output], { stdio: 'inherit' })
chmodSync(output, 0o755)
console.log(`[agent-island-native] built ${output}`)
```
> **待 macOS 核对**：universal 需两次编译（arm64/x86_64）+ `lipo create`，或 `swiftc -arch arm64 -arch x86_64`。Proma 只编 host 架构；Lume 若要 universal，在 macOS 上确认 `swiftc` 多 arch 参数后补全。

- [ ] **Step 2: package.json 接入 prebuild 钩子**

在 `apps/desktop/package.json` 的 scripts 里，构建链前置加 `bun run scripts/build-agent-island-native.ts`（macOS 会编，其他平台 skip）。

- [ ] **Step 3: electron-builder extraResources**

在 electron-builder 配置（`apps/desktop/package.json` 的 build 段或 electron-builder.yml）加：
```json
"extraResources": [
  { "from": "resources/agent-island", "to": "agent-island", "filter": ["**/*"] }
]
```
使 packaged app 读到 `process.resourcesPath/agent-island/macos-agent-island-helper`（与 Task 3 `helperPath()` 对齐）。

- [ ] **Step 4: macOS 端到端验证（仅 macOS）**

Run（macOS 26）: 启动 app，确认灵动岛用原生 NSPanel（非 Electron 窗）；kill helper 确认 4s 回退 Electron 窗。Windows: **跳过**。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/scripts/build-agent-island-native.ts apps/desktop/package.json
git commit -m "🔧 chore(desktop): 灵动岛原生 helper 构建脚本与 extraResources 打包"
```

---

## Self-Review（写计划后自检）

1. **Spec 覆盖**：§4.1 路由→Task 5；§4.2 host 生命周期→Task 3；§4.3 JSONL 协议→Task 2；§4.4 NSPanel/SwiftUI→Task 6；§4.5 构建→Task 7；§4 macOS-only 约束→各 Task 标注。✅
2. **占位符**：Swift Task 6 的 ExpandedIslandView 给了结构 + 关键差异，未逐行抄写 700 行视图代码——这是"基于 Proma 文件适配"而非占位符（参考文件路径明确）。若要求逐行，需在 macOS 上迭代。
3. **类型一致性**：`NativeAgentIslandSnapshot.state` = Lume `AgentIslandState`；Swift `AgentState` Codable 字段逐一对齐（threadId / compactLabel / planning.todos+reminders / presentation / 无 planQuotas）。`value`（非 expanded/hovered）在 Task 2/3/6 一致。`revision` 在 Task 2/3/4 一致。
4. **待确认（§8 开放问题，macOS 核对）**：macOS 26 刘海精确 API（`auxiliaryTopLeftArea/Right` 在 macOS 26 仍可用？需 SDK 核对）；universal binary 的 swiftc 多 arch 参数。

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-08-05-agent-island-phase2.md`.
