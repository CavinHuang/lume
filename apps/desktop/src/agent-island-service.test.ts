// Task 2 (agent-island info-density): service 数据层 TDD 测试。
// 验证 run.started/usage.updated 事件 tap、applyStatus 覆盖式 set 保留新字段、
// recent sessions 投影、idle 判定。deps 注入，无需 mock electron（service 只 type-only 引 BrowserWindow）。
import { expect, test } from 'bun:test'
import { AgentIslandService } from './agent-island-service'

interface FakeWindow {
  isDestroyed: () => boolean
  webContents: { send: (channel: string, payload: unknown) => void }
}

function makeService(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params?: unknown }> = []
  const threads: Array<Record<string, unknown>> = []
  let lastState: unknown = undefined
  const fakeWin: FakeWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel: string, payload: unknown) => {
        lastState = (payload as { state?: unknown }).state
      },
    },
  }
  const deps = {
    isEnabled: () => true,
    isNativeReady: () => false,
    callSidecar: async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'agent:list-threads') return threads
      if (method === 'planning-todo:list') return { items: [] }
      if (method === 'planning-todo:list-active-reminders') return []
      if (method === 'agent:list-workspaces') return []
      return undefined
    },
    getIslandWindow: () => null,
    ensureIslandWindow: () => fakeWin,
    openMain: () => {},
    openSession: () => {},
    setExpandedHeight: () => {},
    publishNativeSnapshot: () => {},
    ...overrides,
  }
  const svc = new AgentIslandService(
    deps as unknown as ConstructorParameters<typeof AgentIslandService>[0],
  )
  return { svc, deps, calls, threads, fakeWin, getLastState: () => lastState }
}

test('applyStatus 覆盖式 set 保留 modelRef/costUSD/tokenTotal + 写 queuedCount', async () => {
  const { svc, getLastState } = makeService()
  const now = Date.now()
  await svc.start()
  // 1. 先用 status 注册 session（applyRuntimeEvent 对未注册会话早返回）
  svc.handleSidecarNotification('agent:runtime-status-changed', {
    status: { threadId: 't1', phase: 'streaming', updatedAt: now },
  })
  // 2. run.started 写 modelRef
  svc.handleSidecarNotification('agent:runtime-event', {
    threadId: 't1',
    event: {
      type: 'run.started',
      model: { provider: 'anthropic', modelId: 'claude-x', modelRef: 'anthropic/claude-x' },
    },
  })
  // 3. usage.updated 覆盖写累计 cost/token（sidecar 维护的累计值，service 不累加）
  svc.handleSidecarNotification('agent:runtime-event', {
    threadId: 't1',
    event: {
      type: 'usage.updated',
      scope: 'main',
      billing: { totalCostUSD: 0.12, cumulative: { totalTokens: 1200 }, records: [] },
    },
  })
  // 4. 再来一次 runtime-status（覆盖式）—— 不应清掉 run/usage 写入值；queuedCount 来自 status
  svc.handleSidecarNotification('agent:runtime-status-changed', {
    status: { threadId: 't1', phase: 'streaming', queuedCount: 3, updatedAt: now + 1000 },
  })
  svc.repush() // 强推绕过 2000ms 节流，确保最后一次 send 捕获到 state
  const state = getLastState() as
    | { sessions?: Array<Record<string, unknown>> }
    | undefined
  expect(state).toBeDefined()
  const session = state!.sessions?.find((s) => s.threadId === 't1')
  expect(session).toBeDefined()
  expect(session!.modelRef).toBe('anthropic/claude-x')
  expect(session!.costUSD).toBe(0.12)
  expect(session!.tokenTotal).toBe(1200)
  expect(session!.queuedCount).toBe(3)
  svc.destroy()
})

test('run.started/usage.updated 未注册会话静默跳过（不抛错）', async () => {
  const { svc } = makeService()
  await svc.start()
  // 未先发 status → sessions Map 为空 → applyRuntimeEvent 各分支早返回
  expect(() => {
    svc.handleSidecarNotification('agent:runtime-event', {
      threadId: 'ghost',
      event: { type: 'run.started', model: { modelRef: 'x/y' } },
    })
    svc.handleSidecarNotification('agent:runtime-event', {
      threadId: 'ghost',
      event: {
        type: 'usage.updated',
        billing: { totalCostUSD: 1.0, cumulative: { totalTokens: 9 } },
      },
    })
  }).not.toThrow()
  svc.destroy()
})

test('refreshThreadMetas 投影 recentSessions 并剔除 active', async () => {
  const { svc, threads, getLastState } = makeService()
  const now = Date.now()
  await svc.start()
  // 让 active session 注册（应在 recent 中剔除）
  svc.handleSidecarNotification('agent:runtime-status-changed', {
    status: { threadId: 'recent1', phase: 'streaming', updatedAt: now },
  })
  // 注入 threads（makeService 的 callSidecar mock 返回同一引用）
  threads.push(
    { id: 'recent1', title: 'Recent One', updatedAt: now, status: 'active', workspaceId: 'ws1' },
    { id: 'recent2', title: 'Recent Two', updatedAt: now - 1000, status: 'active' },
    { id: 'archived', title: 'Archived', updatedAt: now - 2000, status: 'archived' },
  )
  // onThreadListChanged 是 service 的公开入口（main.ts 路由调用）
  await svc.onThreadListChanged()
  svc.repush()
  const state = getLastState() as
    | { recentSessions?: Array<Record<string, unknown>> }
    | undefined
  expect(state).toBeDefined()
  const recent = state!.recentSessions ?? []
  // recent1 仍在 sessions Map（active），不应出现在 recent；archived 被 status 过滤
  const ids = recent.map((r) => r.threadId)
  expect(ids).not.toContain('recent1')
  expect(ids).not.toContain('archived')
  expect(ids).toContain('recent2')
  svc.destroy()
})

test('无 active session 时 isIdle=true（buildSnapshot 内部推导）', async () => {
  const { svc, getLastState } = makeService()
  await svc.start()
  // 不注册任何 session；repush 触发 buildSnapshot 从空 inputs 推导 isIdle=true
  svc.repush()
  const state = getLastState() as { isIdle?: boolean } | undefined
  expect(state).toBeDefined()
  expect(state!.isIdle).toBe(true)
  svc.destroy()
})

test('#125 追问复活会话时 terminalAt 清零，prune 不再按旧终态时间淘汰运行中会话', async () => {
  const { svc } = makeService()
  await svc.start()
  const sessions = () => (svc as unknown as { sessions: Map<string, { terminalAt: number | null }> }).sessions
  svc.handleSidecarNotification('agent:runtime-status-changed', {
    status: { threadId: 't1', phase: 'completed', updatedAt: Date.now() },
  })
  expect(sessions().get('t1')?.terminalAt).toBeGreaterThan(0)
  // 完成后用户追问 → phase 回到 streaming：terminalAt 必须清零，
  // 否则 run 超 10min 后 prune 会误删正在运行的会话（丢失累计 cost/token）
  svc.handleSidecarNotification('agent:runtime-status-changed', {
    status: { threadId: 't1', phase: 'streaming', updatedAt: Date.now() },
  })
  expect(sessions().get('t1')?.terminalAt).toBeNull()
  svc.destroy()
})
