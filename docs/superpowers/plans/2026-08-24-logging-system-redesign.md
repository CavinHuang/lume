# 日志系统重设计 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dev 控制台与正常运行日志都能看到 Lume 关键动作的参数、结果、过程。

**Architecture:** 集中边界包装（`lume:invoke` dispatch + sidecar RPC 出口）产出参数/结果摘要；脱敏拆分为凭据键（全遮蔽）与内容键（200 字符截断预览）并收敛到 `packages/shared`；dev 默认 consoleLevel=trace；Rust 宿主走 `LUMELOG ` 前缀 JSON 行协议由 supervisor 解析。规格见 `docs/superpowers/specs/2026-08-24-logging-system-redesign-design.md`。

**Tech Stack:** TypeScript (bun monorepo)、Electron 主进程、serde_json (Rust)。零新依赖。

**对规格的偏差台账（随实现更新）：**
1. submission 生命周期不新增埋点——rpc/agent-handlers.ts 的 trace spine 已覆盖。
2. node-repl 结构化事件经 sidecar 传输时 source 只能是 sidecar（batch 协议校验），以 context 'node-repl.host' 区分。
3. G5「约 10–20 个事件点」定稿为 4 个（workspace 三事件 + logging.settings_updated）；高频 UI churn 明确不埋。
4. CONTENT_PREVIEW_KEYS 最终清单未纳入规格示例中的 message/text（错误消息不宜截 200 字符），实际 13 键含 contents。

**原两处偏差说明：**
1. submission 生命周期不再新增埋点——`rpc/agent-handlers.ts` 的 trace spine 已覆盖（agent.queue.accepted / execution.started 等）。
2. node-repl 的结构化事件经 sidecar 传输时 source 只能是 `sidecar`（batch 协议校验 `source === expectedSource`），用 `context: 'node-repl.host'` 区分；desktop-host 经主进程 emit 可用真实 source `desktop-host`。

---

### Task 1: shared 日志模块（键分类 + 摘要工具 + quiet 名单收敛）

**Files:**
- Create: `packages/shared/src/logging/index.ts`
- Test: `packages/shared/src/logging/index.test.ts`
- Modify: `packages/shared/src/index.ts`（加一行导出）

- [ ] **Step 1: 写失败测试** `packages/shared/src/logging/index.test.ts`

```ts
import { describe, expect, test } from 'bun:test'
import { REDACT_KEY_PARTS, CONTENT_PREVIEW_KEYS, LOG_PREVIEW_MAX_CHARS, QUIET_RPC_METHODS, clipLogPreview, summarizeValue } from './index'

describe('clipLogPreview', () => {
  test('短字符串原样返回', () => {
    expect(clipLogPreview('hello')).toBe('hello')
  })
  test('超长字符串截断并附原长标注', () => {
    const text = 'a'.repeat(LOG_PREVIEW_MAX_CHARS + 10)
    const clipped = clipLogPreview(text)
    expect(clipped.startsWith('a'.repeat(LOG_PREVIEW_MAX_CHARS))).toBe(true)
    expect(clipped.endsWith('…(+10)')).toBe(true)
    expect(clipped.length).toBeLessThanOrEqual(LOG_PREVIEW_MAX_CHARS + 12)
  })
})

describe('summarizeValue', () => {
  test('凭据键完全 redact（含子串匹配）', () => {
    const out = summarizeValue({ apiKey: 'sk-secret', Authorization: 'Bearer x' }) as Record<string, unknown>
    expect(out.apiKey).toBe('[redacted]')
    expect(out.Authorization).toBe('[redacted]')
  })
  test('内容键输出截断预览而非 [redacted]', () => {
    const long = 'b'.repeat(500)
    const out = summarizeValue({ prompt: long }) as Record<string, unknown>
    expect(typeof out.prompt).toBe('string')
    expect((out.prompt as string).length).toBeLessThan(long.length)
    expect(out.prompt).not.toBe('[redacted]')
  })
  test('普通标量保留、嵌套对象限深、数组给骨架', () => {
    const out = summarizeValue({ id: 7, ok: true, nested: { deep: { deeper: 1 } }, list: [1, 2, 3] }) as Record<string, unknown>
    expect(out.id).toBe(7)
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out.nested)).toContain('[MaxDepth]')
    expect((out.list as { length: number }).length).toBe(3)
  })
  test('对象键数量截断到 30', () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(summarizeValue(big) as Record<string, unknown>).length).toBe(30)
  })
  test('原始类型直接摘要', () => {
    expect(summarizeValue('plain')).toBe('plain')
    expect(summarizeValue(undefined)).toBeUndefined()
    expect(summarizeValue(null)).toBeNull()
  })
})

describe('常量', () => {
  test('REDACT_KEY_PARTS 含 token/password/apikey/authorization', () => {
    for (const part of ['token', 'password', 'apikey', 'authorization']) {
      expect(REDACT_KEY_PARTS).toContain(part)
    }
  })
  test('CONTENT_PREVIEW_KEYS 含 body/prompt/content', () => {
    for (const key of ['body', 'prompt', 'content']) {
      expect(CONTENT_PREVIEW_KEYS.has(key)).toBe(true)
    }
  })
  test('QUIET_RPC_METHODS 为双端并集（含 channel:oauth-status）', () => {
    expect(QUIET_RPC_METHODS.has('channel:oauth-status')).toBe(true)
    expect(QUIET_RPC_METHODS.has('healthcheck')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/shared && bun test src/logging/index.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/shared/src/logging/index.ts`

```ts
/**
 * Unified logging details shared by all processes.
 *
 * Key classification rules:
 * - REDACT_KEY_PARTS: credential-like keys → fully "[redacted]" (substring match, never logged).
 * - CONTENT_PREVIEW_KEYS: payload-like keys → truncated preview (first N chars), so
 *   "key action params/results" stay observable without leaking full bodies.
 */

export const LOG_PREVIEW_MAX_CHARS = 200

/** Substring fragments; a key whose normalized form CONTAINS any fragment is fully redacted. */
export const REDACT_KEY_PARTS: readonly string[] = [
  'token', 'secret', 'password', 'apikey', 'authorization',
  'cookie', 'setcookie', 'accesstoken', 'refreshtoken', 'grant',
]

/** Normalized key EXACTLY in this set → truncated preview instead of full redaction. */
export const CONTENT_PREVIEW_KEYS: ReadonlySet<string> = new Set([
  'body', 'prompt', 'systemprompt', 'rawrequest', 'rawresponse', 'requestbody', 'responsebody',
  'content', 'html', 'markdown', 'input', 'output',
])

/** Union of both processes' quiet lists; failures are NEVER quiet regardless of this set. */
export const QUIET_RPC_METHODS: ReadonlySet<string> = new Set([
  'healthcheck',
  'general-settings:get',
  'agent:list-threads',
  'agent:list-subagent-runs',
  'agent:get-pending-interactive',
  'agent:list-workspaces',
  'channel:oauth-status',
  'model-meta:get',
])

export type LogKeyClass = 'redact' | 'preview' | 'keep'

export function classifyLogKey(key: string): LogKeyClass {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '')
  if (REDACT_KEY_PARTS.some((part) => normalized.includes(part))) return 'redact'
  if (CONTENT_PREVIEW_KEYS.has(normalized)) return 'preview'
  return 'keep'
}

export function clipLogPreview(text: string): string {
  return text.length > LOG_PREVIEW_MAX_CHARS
    ? `${text.slice(0, LOG_PREVIEW_MAX_CHARS)}…(+${text.length - LOG_PREVIEW_MAX_CHARS})`
    : text
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text ?? String(value)
  } catch {
    return String(value)
  }
}

const SUMMARIZE_MAX_DEPTH = 2
const SUMMARIZE_MAX_KEYS = 30

/**
 * Bounded, redaction-aware summary of an arbitrary payload for log `data` fields.
 * Primitives pass through; strings are clipped; objects are shallow-walked with
 * key classification applied at every level.
 */
export function summarizeValue(input: unknown, depth = 0): unknown {
  if (input == null || typeof input === 'boolean' || typeof input === 'number') return input
  if (typeof input === 'string') return clipLogPreview(input)
  if (typeof input !== 'object') return `[${typeof input}]`
  if (depth >= SUMMARIZE_MAX_DEPTH) return '[MaxDepth]'
  if (Array.isArray(input)) {
    return {
      length: input.length,
      items: input.slice(0, 5).map((item) => summarizeValue(item, depth + 1)),
    }
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>).slice(0, SUMMARIZE_MAX_KEYS)) {
    const classified = classifyLogKey(key)
    if (classified === 'redact') {
      out[key] = '[redacted]'
      continue
    }
    if (classified === 'preview' && typeof value !== 'string') {
      out[key] = clipLogPreview(safeJson(value))
      continue
    }
    out[key] = summarizeValue(value, depth + 1)
  }
  return out
}
```

- [ ] **Step 4:** 在 `packages/shared/src/index.ts` 的 `export * from "./stable-serialize";` 之后加：

```ts
export * from "./logging";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/shared && bun test src/logging/index.test.ts`
Expected: PASS 全部

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/logging packages/shared/src/index.ts
git commit -m "feat(logging): shared 键分类/截断预览/quiet 名单单一来源"
```

---

### Task 2: 三端 normalizer 接入共享分类（内容键 → 预览）

**Files:**
- Modify: `apps/desktop/src/logging/logging-service.ts:79-94`（删本地 SENSITIVE_KEYS/SENSITIVE_PAYLOAD_KEYS）、`:114-117`（isSensitiveKey）、`:150-164`（normalizeLogValue 对象分支）
- Modify: `apps/sidecar/src/services/infra/logger.ts:39-51` 与 normalize 分支（同构改法）
- Modify: `apps/web/src/lib/desktop-api/logger.ts:40-47`
- Test: `apps/desktop/scripts/logging-service.test.mjs`（追加用例）

- [ ] **Step 1: logging-service.test.mjs 追加失败用例**（沿用该文件现有的 new LoggingService + emit 断言风格；在文件末尾测试区追加）

```js
test('content keys are previewed instead of redacted', async () => {
  const service = new LoggingService({ configDir: tempDir, terminal: fakeTerminal, now: () => new Date() })
  service.updateSettings({ fileLevel: 'info' })
  const event = service.emit({
    level: 'info',
    source: 'main',
    context: 'test',
    event: 'preview.case',
    message: 'x',
    data: { prompt: 'z'.repeat(500), apiKey: 'sk-live' },
  })
  // emit 同步返回 normalized 事件；队列里的事件通过 flush 后文件内容断言亦可，
  // 这里直接断言返回值的 data 字段。
  assert.equal(event.data.apiKey, '[redacted]')
  assert.ok(event.data.prompt.startsWith('z'.repeat(200)))
  assert.ok(event.data.prompt.endsWith('…(+300)'))
})
```

（按该文件已有的 tempDir/fakeTerminal 辅助命名适配；若辅助名不同，用文件内现成的。）

Run: `cd apps/desktop && bun test scripts/logging-service.test.mjs` → 新用例 FAIL（prompt 是 `[redacted]`）

- [ ] **Step 2: 改 logging-service.ts**

顶部 import 增加：

```ts
import { LUME_LOGGING_DEFAULTS, LUME_LOG_SCHEMA_VERSION, classifyLogKey, clipLogPreview } from '@lume/shared'
```

删除本地 `SENSITIVE_KEYS`（79-90 行）与 `SENSITIVE_PAYLOAD_KEYS`（91-94 行）；删除 `isSensitiveKey`（114-117 行）。`normalizeLogValue` 对象分支（152-163 行）改为：

```ts
  for (const key of Object.keys(descriptors).slice(0, MAX_DATA_KEYS)) {
    state.keys += 1
    if (state.keys > MAX_DATA_KEYS) break
    const classified = classifyLogKey(key)
    if (classified === 'redact') {
      output[key] = '[redacted]'
      continue
    }
    const descriptor = descriptors[key]
    const resolved = descriptor && 'value' in descriptor
      ? normalizeLogValue(descriptor.value, depth + 1, state)
      : '[Accessor]'
    output[key] = classified === 'preview' && typeof resolved === 'string'
      ? clipLogPreview(resolved)
      : resolved
  }
```

注意：`normalizeString`（8192 上限）仍先作用于字符串，preview 截断在其后叠加，行为兼容。

- [ ] **Step 3: sidecar logger.ts 同构修改**

`apps/sidecar/src/services/infra/logger.ts`：从 `@lume/shared` import `classifyLogKey, clipLogPreview`，删除本地 `SENSITIVE_KEYS`/`SENSITIVE_PAYLOAD_KEYS` 数组，把其 normalize 函数中的敏感键判断分支替换为与 Step 2 相同的 classify 三分支模式（该文件的 normalizeValue 与 logging-service 结构相同，照搬改法；保持其余逻辑不动）。

- [ ] **Step 4: web logger.ts 同构修改**

`apps/web/src/lib/desktop-api/logger.ts:39-52`：import `classifyLogKey, clipLogPreview`，替换内联的 includes 判断为 classify 三分支（preview 分支对 string 结果做 clipLogPreview）。

- [ ] **Step 5: 全部相关测试通过**

```bash
cd apps/desktop && bun test scripts/logging-service.test.mjs scripts/log-digest-policy.test.mjs
cd ../sidecar && bun test src/services/infra/logger.test.ts src/services/infra/logging-source-contract.test.ts
cd ../../web && bun run test:unit
```
Expected: 全 PASS。若 logging-source-contract 校验 redaction 形状，按契约更新其期望（内容键现在是预览串）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/logging/logging-service.ts apps/desktop/scripts/logging-service.test.mjs apps/sidecar/src/services/infra/logger.ts apps/web/src/lib/desktop-api/logger.ts
git commit -m "feat(logging): 内容键改为截断预览，凭据键维持全遮蔽，三端规则统一走 shared"
```

---

### Task 3: dev 默认 trace + sidecar 级别转发

**Files:**
- Modify: `apps/desktop/src/logging/logging-service.ts`（Options + 构造器 + getSettings）
- Modify: `apps/desktop/src/main.ts`（getLoggingService ~307 行、createSpawnConfig ~2514 行）

- [ ] **Step 1: LoggingServiceOptions 增加字段**

```ts
export interface LoggingServiceOptions {
  configDir: string
  settings?: Partial<LumeLoggingSettings>
  /** Dev build (not packaged): console defaults to trace unless env/persisted override. */
  isDev?: boolean
  terminal?: Pick<NodeJS.WriteStream, 'write'>
  now?: () => Date
}
```

构造器第一行 `this.settings = { ...LUME_LOGGING_DEFAULTS, ...options.settings }` 之后加：

```ts
    // Dev 默认放开控制台到 trace：显式 env 或用户持久化的非默认值优先。
    // 持久化值等于全局默认(info)时视为"未自定义"，同样放行 dev trace。
    if (options.isDev && !process.env.LUME_LOG_CONSOLE_LEVEL && this.settings.consoleLevel === LUME_LOGGING_DEFAULTS.consoleLevel) {
      this.settings.consoleLevel = 'trace'
    }
```

类内新增只读访问器（放在 `updateSettings` 旁）：

```ts
  getSettings(): Readonly<LumeLoggingSettings> {
    return this.settings
  }
```

- [ ] **Step 2: main.ts getLoggingService 传入 isDev**

```ts
    loggingService = new LoggingService({
      configDir: resolveConfigDir(),
      isDev: !app.isPackaged,
      ...(logging && typeof logging === 'object' ? { settings: logging } : {}),
    })
```

- [ ] **Step 3: createSpawnConfig 转发级别**（env 字面量块内追加一项，放在 `LUME_CONFIG_DIR` 之后）

```ts
      // sidecar 源头门槛决定 debug/trace 是否进入传输；落盘仍由主进程 fileLevel 把关。
      LUME_LOG_FILE_LEVEL: process.env.LUME_LOG_FILE_LEVEL
        ?? (!app.isPackaged ? 'trace' : loggingService?.getSettings().fileLevel ?? 'info'),
```

- [ ] **Step 4: 测试**（logging-service.test.mjs 追加）

```js
test('dev builds default console level to trace until overridden', () => {
  const service = new LoggingService({ configDir: tempDir, isDev: true, terminal: fakeTerminal, now: () => new Date() })
  assert.equal(service.getSettings().consoleLevel, 'trace')
  const prod = new LoggingService({ configDir: tempDir, terminal: fakeTerminal, now: () => new Date() })
  assert.equal(prod.getSettings().consoleLevel, 'info')
  const custom = new LoggingService({ configDir: tempDir, isDev: true, settings: { consoleLevel: 'warn' }, terminal: fakeTerminal, now: () => new Date() })
  assert.equal(custom.getSettings().consoleLevel, 'warn')
})
```

Run: `cd apps/desktop && bun test scripts/logging-service.test.mjs` → PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/logging/logging-service.ts apps/desktop/src/main.ts apps/desktop/scripts/logging-service.test.mjs
git commit -m "feat(logging): dev 构建控制台默认 trace，sidecar spawn 显式转发日志级别"
```

---

### Task 4: 主进程 IPC 参数/结果埋点

**Files:**
- Modify: `apps/desktop/src/main.ts`（writeMainLog 附近新增 logIpcCommand/handleLogged；`lume:invoke` 3030-3042 包装；其余 `ipcMain.handle(` 注册机械替换为 handleLogged，排除 `/log/i 通道与 lume:invoke`）
- Test: 手动冒烟为主（Task 11 统一验证）；单测不为此在 main.ts 制造接缝

- [ ] **Step 1: 新增 helper**（紧跟 `writeMainLog` 定义之后）

```ts
const QUIET_IPC_COMMANDS = new Set<string>([
  // 启动后观察 dev 终端 command.completed 频率，把高频轮询命令加进来。
])
const IPC_LOG_CONTEXT = 'desktop.ipc'

async function logIpcCommand<T>(name: string, args: unknown, run: () => Promise<T> | T): Promise<T> {
  if (QUIET_IPC_COMMANDS.has(name)) return await run()
  const startedAt = performance.now()
  try {
    const result = await run()
    writeMainLog('debug', IPC_LOG_CONTEXT, 'command.completed', `ipc completed: ${name}`, {
      durationMs: Math.round(performance.now() - startedAt),
      data: { command: name, args: summarizeValue(args), result: summarizeValue(result) },
    })
    return result
  } catch (error) {
    writeMainLog('warn', IPC_LOG_CONTEXT, 'command.failed', `ipc failed: ${name}`, {
      durationMs: Math.round(performance.now() - startedAt),
      data: { command: name, args: summarizeValue(args) },
      ...(error instanceof Error ? { error } : {}),
    })
    throw error
  }
}

function handleLogged(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => logIpcCommand(channel, args[0], () => handler(event, ...args)))
}
```

main.ts 顶部 import 补 `summarizeValue`（来自 `@lume/shared`，加入现有 shared import 列表）。

- [ ] **Step 2: 包一层 lume:invoke**（3030 行附近，handler 内最后一行 return 替换）

```ts
ipcMain.handle('lume:invoke', async (event, command, payload) => {
  validateIpcSender(event, getTrustedWindows())
  const ownerWebContentsId = event.sender.id
  if (!attachmentStageOwners.has(ownerWebContentsId)) {
    attachmentStageOwners.add(ownerWebContentsId)
    event.sender.once('destroyed', () => {
      attachmentStageOwners.delete(ownerWebContentsId)
      attachmentStages.cleanupOwner(ownerWebContentsId)
      pluginAssets.revokeOwner(ownerWebContentsId)
    })
  }
  return logIpcCommand(
    validateRendererInvokeCommand(command),
    payload,
    () => dispatchCommand(validateRendererInvokeCommand(command), payload, { ownerWebContentsId }),
  )
})
```

（validateRendererInvokeCommand 调两次略冗，可提为局部 const commandName 复用。）

- [ ] **Step 3: 机械转换其余注册**：`grep -nF "ipcMain.handle(" apps/desktop/src/main.ts` 得到全部注册点，逐个改为 `handleLogged(...)`，**排除**通道名含 `log` 的（如 `write_web_log_batch`、`desktop_read_log_file`、`desktop_list_log_file`、`desktop_export_logs`、`desktop_delete_logs`——它们本身是日志操作，包装会自我反馈）与已内部包装的 `lume:invoke`。每处仅改外层函数名，handler 体不动。

- [ ] **Step 4: typecheck**

Run: `cd apps/desktop && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(logging): lume:invoke 与独立 IPC 注册的参数/结果/耗时埋点"
```

---

### Task 5: sidecar RPC 摘要 + quiet 名单收敛

**Files:**
- Modify: `apps/sidecar/src/index.ts`（128-136 本地 QUIET_RPC_METHODS 删除改 import；~288-318 两条记录补摘要）
- Modify: `apps/desktop/src/main.ts`（192-201 本地 QUIET_SIDECAR_RPC_METHODS 删除改 import shared 并重命名引用处）

- [ ] **Step 1: sidecar index.ts**

顶部 `import { ..., QUIET_RPC_METHODS, summarizeValue } from "@lume/shared"`（并入现有 shared import），删除本地 `QUIET_RPC_METHODS` 定义（128-136 行）。RPC 记录两处改为：

completed（原 else-if 分支）：

```ts
    } else if (!QUIET_RPC_METHODS.has(method)) {
      writeLogRecord({
        level: "debug",
        context: "rpc.server",
        event: "rpc.completed",
        message: `sidecar RPC completed: ${method}`,
        status: "ok",
        durationMs,
        rpcRequestId: String(payload.id),
        data: { method, params: summarizeValue(payload.params), result: summarizeValue(result) },
      });
    }
```

failed（catch 内）data 改为 `{ method, params: summarizeValue(payload.params), error }`。
另外 slow 分支 data 也补 `params: summarizeValue(payload.params)`。

- [ ] **Step 2: main.ts 收敛**

删除本地 `QUIET_SIDECAR_RPC_METHODS`（192-201 行），import `QUIET_RPC_METHODS as QUIET_SIDECAR_RPC_METHODS`（或直接改名使用处，2830 行一处）from '@lume/shared'。

- [ ] **Step 3: 测试**

```bash
cd apps/sidecar && bun run typecheck && bun test src/services/infra/logger.test.ts
cd ../desktop && bun run typecheck
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/index.ts apps/desktop/src/main.ts
git commit -m "feat(logging): sidecar RPC 记录补参数/结果摘要，quiet 名单收敛 shared"
```

---

### Task 6: renderer console 桥接

**Files:**
- Create: `apps/web/src/lib/console-bridge.ts`
- Test: `apps/web/src/lib/console-bridge.test.ts`
- Modify: `apps/web/src/main.tsx`（bootstrap 前 install）

- [ ] **Step 1: 写失败测试**

```ts
// @vitest-environment jsdom 不需要；web 单测走 bun test + happy-dom 由现有配置提供
import { describe, expect, test, beforeEach } from 'bun:test'
import { installConsoleBridge, resetConsoleBridgeForTest } from './console-bridge'
import { readRendererQueueForTest } from './desktop-api/logger'

describe('console bridge', () => {
  beforeEach(() => resetConsoleBridgeForTest())

  test('console.error 转发为 renderer/console.error 事件', () => {
    installConsoleBridge()
    console.error('boom', { code: 42 })
    const queue = readRendererQueueForTest()
    const last = queue[queue.length - 1]
    expect(last.context).toBe('console')
    expect(last.event).toBe('console.error')
    expect(last.level).toBe('error')
    expect(last.message).toContain('boom')
  })

  test('限流：窗口内超过 30 条丢弃并计数', () => {
    installConsoleBridge()
    for (let i = 0; i < 35; i++) console.warn(`w${i}`)
    const queue = readRendererQueueForTest()
    const bridged = queue.filter((e: { context: string }) => e.context === 'console')
    expect(bridged.length).toBeLessThanOrEqual(30)
  })

  test('Error 入参带 stack', () => {
    installConsoleBridge()
    console.error(new Error('with-stack'))
    const last = readRendererQueueForTest().at(-1)
    expect(String(last?.data?.stack)).toContain('Error: with-stack')
  })
})
```

若 web 现有单测没有读取 logger 内部队列的先例：在 `logger.ts` 导出 `readRendererQueueForTest(): readonly LumeLogEventInput[] { return queue }`（一行 getter，fire-and-forget 队列本就进程内私有，测试需要观测点）。

- [ ] **Step 2: 实现** `apps/web/src/lib/console-bridge.ts`

```ts
/**
 * Bridges console.error/warn into the unified log pipeline.
 * Release builds have no DevTools — without this, those diagnostics are lost.
 * Fixed-window rate limit keeps floods from saturating the transport.
 */
import { writeWebLogEvent } from '@/lib/desktop-api/logger'

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 30

let windowStart = 0
let sentInWindow = 0
let droppedInWindow = 0
let installed = false

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function forward(level: 'error' | 'warn', args: unknown[]): void {
  const now = Date.now()
  if (now - windowStart >= WINDOW_MS) {
    if (droppedInWindow > 0) {
      writeWebLogEvent({
        level: 'warn',
        kind: 'log',
        context: 'console.bridge',
        event: 'console.dropped',
        message: `dropped ${droppedInWindow} console messages in previous window`,
        data: { dropped: droppedInWindow },
      })
      droppedInWindow = 0
    }
    windowStart = now
    sentInWindow = 0
  }
  if (sentInWindow >= MAX_PER_WINDOW) {
    droppedInWindow += 1
    return
  }
  sentInWindow += 1
  const firstError = args.find((arg): arg is Error => arg instanceof Error)
  writeWebLogEvent({
    level,
    kind: 'log',
    context: 'console',
    event: level === 'error' ? 'console.error' : 'console.warn',
    message: args.map(formatValue).join(' ').slice(0, 2_000),
    ...(firstError?.stack ? { data: { stack: firstError.stack } } : {}),
  })
}

export function installConsoleBridge(): void {
  if (installed) return
  installed = true
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      try {
        forward(level, args)
      } catch {
        // Bridge failures must never alter caller behavior.
      }
      original(...args)
    }
  }
}

export function resetConsoleBridgeForTest(): void {
  installed = false
  windowStart = 0
  sentInWindow = 0
  droppedInWindow = 0
}
```

- [ ] **Step 3: 接线** `apps/web/src/main.tsx`：`installGlobalErrorToast()` 之前加：

```ts
import { installConsoleBridge } from './lib/console-bridge'
...
installConsoleBridge()
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && bun run test:unit`
Expected: PASS（含既有套件）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/console-bridge.ts apps/web/src/lib/console-bridge.test.ts apps/web/src/lib/desktop-api/logger.ts apps/web/src/main.tsx
git commit -m "feat(logging): renderer console error/warn 桥接进统一日志（限流防刷）"
```

---

### Task 7: supervisor 解析 desktop-host LUMELOG 行

**Files:**
- Modify: `apps/desktop/src/desktop-host-supervisor.ts`（Options 加 logEvent；stdout/stderr 回调改经行缓冲解析）
- Modify: `apps/desktop/src/main.ts`（createDesktopHostSupervisor 实例化 ~3306 传入 logEvent）
- Test: `apps/desktop/src/desktop-host-supervisor.test.ts`（追加解析用例）

- [ ] **Step 1: 失败测试**（沿用该测试文件现有的假 spawn 注入风格；核心断言如下）

```ts
test('structured LUMELOG stderr lines are parsed and routed to logEvent', async () => {
  // 用现有测试的 fake child 进程手段向 stderr 写入：
  // 'LUMELOG {"level":"warn","context":"host.pipe","event":"pipe.error","message":"boom"}\n'
  // 断言 options.logEvent 被以 {level:'warn',context:'host.pipe',event:'pipe.error',message:'boom'} 调用；
  // 同时写入普通行 'plain text'，断言仍走旧 log() 文本路径。
})
```

（按该文件现有 helper 具体化；文件里已有 spawn 注入与 stdout 数据驱动用例可仿写。）

- [ ] **Step 2: 实现**

Options 增加：

```ts
interface DesktopHostStructuredLog {
  level?: string
  context?: string
  event?: string
  message?: string
  data?: Record<string, unknown>
}
// DesktopHostSupervisorOptions 增加：
logEvent?: (event: DesktopHostStructuredLog) => void
```

spawnHost 中两个 data 回调替换为行缓冲解析：

```ts
  const LUMELOG_PREFIX = 'LUMELOG '
  const lineBuffers = { stdout: '', stderr: '' }
  const ingestChunk = (stream: 'stdout' | 'stderr', chunk: string) => {
    lineBuffers[stream] += chunk
    const lines = lineBuffers[stream].split('\n')
    lineBuffers[stream] = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (!line) continue
      if (!line.startsWith(LUMELOG_PREFIX)) {
        log(`[desktop-host] ${line}`)
        continue
      }
      try {
        const parsed = JSON.parse(line.slice(LUMELOG_PREFIX.length)) as DesktopHostStructuredLog
        logEvent?.(parsed)
      } catch {
        log(`[desktop-host] ${line}`)
      }
    }
  }
  running.stdout?.on('data', (chunk) => ingestChunk('stdout', String(chunk)))
  running.stderr?.on('data', (chunk) => ingestChunk('stderr', String(chunk)))
```

exit/error 回调里的 `log(...)` 保持不变（非流式文本）。

- [ ] **Step 3: main.ts 接线**（3306 行实例化处）

```ts
    desktopHostSupervisor = createDesktopHostSupervisor({
      binaryPath,
      log: logDesktopStartup,
      logEvent: ({ level, context, event, message, data }) => writeMainLog(
        level === 'fatal' ? 'error' : level ?? 'info',
        context ?? 'desktop.host',
        event ?? 'host.log',
        message ?? '',
        { source: 'desktop-host', ...(data ? { data } : {}) },
      ),
    })
```

（writeMainLog 的 extra 展开在 source: 'main' 之后，source 覆盖生效；emit→accept 链路允许任意合法 source。）

- [ ] **Step 4: 跑测试**

Run: `cd apps/desktop && bun test src/desktop-host-supervisor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/desktop-host-supervisor.ts apps/desktop/src/main.ts apps/desktop/src/desktop-host-supervisor.test.ts
git commit -m "feat(logging): supervisor 解析 desktop-host LUMELOG 结构化行"
```

---

### Task 8: Rust 宿主 LUMELOG 输出 + node-repl stderr 解析

**Files:**
- Create: `crates/lume-desktop-host/src/logging.rs`（+ main.rs `mod logging;`）
- Create: `crates/lume-node-repl-host/src/logging.rs`（同构副本；两 crate 无共享依赖，20 行复制可接受）
- Modify: `crates/lume-desktop-host/src/main.rs:21,125,181,202`（eprintln → emit_log）
- Modify: `crates/lume-node-repl-host/src/main.rs:17,26`（println! 版本号 :35 保持纯文本）
- Modify: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-manager.ts`（stderr 行解析）
- Test: cargo test 两 crate；sidecar 侧如该 manager 有既有测试文件则追加解析用例

- [ ] **Step 1: Rust logging.rs（两 crate 相同内容）**

```rust
use serde_json::Value;

/// Single-line structured log protocol consumed by the desktop supervisor.
pub const LUMELOG_PREFIX: &str = "LUMELOG ";

pub fn log_line(level: &str, context: &str, event: &str, message: &str, data: Option<Value>) -> String {
    let mut payload = serde_json::json!({
        "level": level,
        "context": context,
        "event": event,
        "message": message,
    });
    if let Some(data) = data {
        payload["data"] = data;
    }
    format!("{LUMELOG_PREFIX}{payload}")
}

pub fn emit_log(level: &str, context: &str, event: &str, message: &str, data: Option<Value>) {
    eprintln!("{}", log_line(level, context, event, message, data));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_has_prefix_and_parses_back() {
        let line = log_line("warn", "host.pipe", "pipe.error", "boom", None);
        assert!(line.starts_with(LUMELOG_PREFIX));
        let parsed: Value =
            serde_json::from_str(&line[LUMELOG_PREFIX.len()..]).expect("valid json");
        assert_eq!(parsed["event"], "pipe.error");
        assert_eq!(parsed["level"], "warn");
        assert_eq!(parsed["message"], "boom");
    }

    #[test]
    fn data_field_is_attached_when_present() {
        let line = log_line("info", "c", "e", "m", Some(serde_json::json!({"k": 1})));
        let parsed: Value = serde_json::from_str(&line[LUMELOG_PREFIX.len()..]).unwrap();
        assert_eq!(parsed["data"]["k"], 1);
    }
}
```

- [ ] **Step 2: 替换调用点**

desktop-host main.rs：
- `:21` `eprintln!("lume_desktop_host failed: {error:#}")` → `logging::emit_log("fatal", "host.lifecycle", "host.failed", &format!("lume_desktop_host failed: {error:#}"), None)`
- `:125` event monitor unavailable → `("warn", "host.event_monitor", "monitor.unavailable", ...)`
- `:181` / `:202` client disconnected → `("warn", "host.pipe", "client.disconnected", ...)`
- 文件头部加 `mod logging;`

node-repl-host main.rs：
- `:17` failed → `("fatal", "repl.lifecycle", "run.failed", ...)`
- `:26` argument parsing failed → `("warn", "repl.lifecycle", "args.invalid", ...)`
- `:35` `println!("node_repl {SERVER_VERSION}")` 保持不变（版本查询是给人看的 stdout）
- 文件头部加 `mod logging;`

- [ ] **Step 3: cargo 验证**

Run: `cargo test -p lume-desktop-host -p lume-node-repl-host`
Expected: 新增 2×2 测试 PASS，存量测试不回归

- [ ] **Step 4: sidecar node-repl-runtime-manager stderr 解析**

该文件 `:95 private stderr = ""`、`:173` spawn、`:212` 失败时输出 stderr。改动：

```ts
private stderrLineBuffer = ""
private ingestStderrChunk(chunk: string): void {
  this.stderrLineBuffer += chunk
  const lines = this.stderrLineBuffer.split("\n")
  this.stderrLineBuffer = lines.pop() ?? ""
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line) continue
    if (!line.startsWith(LUMELOG_PREFIX)) {
      this.stderr += `${line}\n`   // 维持旧行为：失败诊断时可见
      continue
    }
    try {
      const parsed = JSON.parse(line.slice(LUMELOG_PREFIX.length)) as {
        level?: string; context?: string; event?: string; message?: string; data?: Record<string, unknown>
      }
      writeLogRecord({
        level: parsed.level === "fatal" ? "error" : parsed.level ?? "info",
        context: parsed.context ?? "node-repl.host",
        event: parsed.event ?? "host.log",
        message: parsed.message ?? "",
        ...(parsed.data ? { data: parsed.data } : {}),
      })
    } catch {
      this.stderr += `${line}\n`
    }
  }
}
```

spawn 处 stderr 监听改为 `(chunk) => this.ingestStderrChunk(String(chunk))`；`LUMELOG_PREFIX = "LUMELOG "` 常量与 `writeLogRecord` 从 infra/logger import。注意：**stdout 是 JSONL 控制协议通道，禁止接入此解析**。批协议限制下 source 保持默认 sidecar（见计划头偏差说明 2），靠 context 过滤。

- [ ] **Step 5: sidecar 验证**

Run: `cd apps/sidecar && bun run typecheck && bun test src/services/agent-runtime/tools/node-repl/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/lume-desktop-host crates/lume-node-repl-host apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-manager.ts
git commit -m "feat(logging): Rust 宿主输出 LUMELOG 结构化行，sidecar 解析 node-repl stderr"
```

---

### Task 9: 关键动作显式埋点（store/生命周期/settings）

**Files:**
- Modify: `apps/desktop/src/browser-workspace-store.ts`（constructor 加可选 onEvent；close/move/importLegacy 各加一条 info）
- Modify: `apps/desktop/src/main.ts`（workspace store 实例化处接线；settings-replace 成功后加 logging.settings_updated）
- Test: `apps/desktop/src/browser-workspace-store.test.ts`（追加 onEvent 断言）

- [ ] **Step 1: store 注入回调**

```ts
export interface BrowserWorkspaceLogEvent {
  level: 'info' | 'debug'
  event: string
  message: string
  data?: Record<string, unknown>
}

constructor(configDir: () => string, private onEvent?: (event: BrowserWorkspaceLogEvent) => void) {}

private report(event: BrowserWorkspaceLogEvent): void {
  try { this.onEvent?.(event) } catch { /* 观测不得影响业务 */ }
}
```

- close()（:80）成功路径末尾：`this.report({ level: 'info', event: 'browser.workspace.tab_closed', message: `closed tab ${tab.id}`, data: { ownerThreadId: tab.ownerThreadId ?? undefined, tabId: tab.id } })`
- move()（:74）：`browser.workspace.tab_moved`（data 带 tabId、from/to ownerThreadId）
- importLegacy()（:118）：`browser.workspace.imported`（data 带 importedTabCount）
- activate/reorder/rememberTab 为高频 UI churn，不埋（读级操作）。

- [ ] **Step 2: main.ts 接线**：grep workspace store 实例化点，传第二个参数：

```ts
new BrowserWorkspaceStore(resolveConfigDir, ({ level, event, message, data }) =>
  writeMainLog(level, 'browser.workspace', event, message, { ...(data ? { data } : {}) }))
```

- [ ] **Step 3: settings-replace 埋点**：grep `SIDECAR_SETTINGS_REPLACE_METHOD` 的处理位置（updateSettings 调用成功后）：

```ts
writeMainLog('info', 'logging.config', 'logging.settings_updated', 'logging settings replaced', {
  data: summarizeValue(nextSettings),
})
```

（`nextSettings` 为传给 updateSettings 的局部值；summarizeValue 已在 Task 4 引入。）

- [ ] **Step 4: 测试**（workspace-store.test.ts 追加：构造时传 onEvent spy，调用 close()，断言收到 tab_closed 事件且 data 含 tabId）

Run: `cd apps/desktop && bun test src/browser-workspace-store.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/browser-workspace-store.ts apps/desktop/src/browser-workspace-store.test.ts apps/desktop/src/main.ts
git commit -m "feat(logging): 工作台关闭/迁移/导入与日志设置热更的关键动作埋点"
```

---

### Task 10: 日志约定文档

**Files:**
- Create: `docs/logging.md`

- [ ] **Step 1: 写文档**，结构固定为以下小节（中文，正文自拟但须覆盖全部条目）：

1. **总览**：数据流图（文字版）：产生者(main/sidecar/renderer/Rust hosts) → LoggingService(main) → ①dev stderr ②`~/.lume/logs/lume-YYYY-MM-DD.ndjson` ③应用内查看器(LogSettings)。
2. **schema v2 速览**：级别 6 档、来源 5 种、kind(log/trace)、关联 ID 列表、durationMs/status。
3. **命名规则**：context 用「域.子域」（`desktop.ipc` / `rpc.server` / `browser.workspace` / `logging.config`）；event 用点分动词短语（`command.completed` / `tab_closed`）。
4. **级别使用规则**：状态变更=info；读取/高频=debug；可恢复异常=warn；失败=error(+error 字段)；全量 IPC 往返=debug（dev 控制台可见）；生产文件可见性靠 info 及以上。
5. **脱敏与预览**：REDACT_KEY_PARTS 子串命中→`[redacted]`；CONTENT_PREVIEW_KEYS 精确命中→200 字符预览（`clipLogPreview`）；全文走加密 diagnostic-content-store；新键名如何归类。
6. **quiet 名单政策**：`QUIET_RPC_METHODS`（shared 单一来源）只豁免成功路径，失败永远记录；新增高频命令如何入名单。
7. **Rust 宿主协议**：`LUMELOG `前缀 + 单行 JSON（level/context/event/message/data），supervisor 解析失败回退文本。
8. **新增一个埋点的步骤**：选 context/event → 选级别（按 §4）→ data 用 `summarizeValue` 或显式字段 → 敏感键自查。
9. **dev 怎么看日志**：dev 构建控制台默认 trace（持久化为默认值视为未自定义）；env 表 `LUME_LOG_CONSOLE_LEVEL` / `LUME_LOG_FILE_LEVEL` / `LUME_LOG_FORMAT=json` / `LUME_LOG_CONSOLE=false`；生产排查用 LogSettings 查看器与导出。

- [ ] **Step 2: Commit**

```bash
git add docs/logging.md
git commit -m "docs(logging): 日志系统约定与使用指南"
```

---

### Task 11: 全量验证 + 手动冒烟清单

- [ ] **Step 1: 全仓校验**

```bash
bun run typecheck && bun run test:core
cargo test -p lume-desktop-host -p lume-node-repl-host
```
Expected: 全绿。

- [ ] **Step 2: 手动冒烟**（`bun run dev`，观察 dev 终端）：

1. 启动即见 app.started / sidecar.ready / logging.started 等 spine 流。
2. 渲染层触发任一命令（如打开设置），终端出现 `desktop.ipc command.completed` 行，含 durationMs；pretty 格式下 message 直读，`LUME_LOG_FORMAT=json bun run dev` 时为整行 JSON。
3. 触发一次 agent 会话，终端可见 message.accepted → agent.run.started → provider.request.completed 链路（此前默认不可见）。
4. `~/.lume/logs/lume-<today>.ndjson` 里 grep `command.completed` 有记录（fileLevel=info 下 debug 往返不入盘属预期；grep `logging.settings_updated`、`browser.workspace.` 应有 info 记录）。
5. 在渲染层 console 执行 `console.error('smoke')`，LogSettings 查看器实时订阅出现 renderer/console.error 事件。
6. 观察 30 秒终端无高频命令刷屏；若有，把该命令加入 `QUIET_IPC_COMMANDS` 再验。

- [ ] **Step 3: 若冒烟有修，补 commit 后进入子代理 review 循环。**

---

## Self-Review 记录

- 规格覆盖：G1→Task 3；G2→Task 4/5；G3→Task 6；G4→Task 7/8；G5→Task 9；G6→Task 1/5；G7→Task 10；验证→Task 11。✓
- 偏差声明：计划头部两处（submission 不重复埋点；node-repl source 限制）。✓
- 类型一致性：classifyLogKey/clipLogPreview/summarizeValue/QUIET_RPC_METHODS/getSettings/isDev/logEvent 各任务间签名一致。✓
