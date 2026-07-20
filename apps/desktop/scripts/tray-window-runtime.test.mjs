import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import {
  createAsyncSingleFlight,
  createEventRateLimiter,
  createMainWindowLifecycleState,
  destroyTrayWithFallback,
  isMainWindowSender,
  validateTrayStatePayload,
  waitForWindowReady,
} from '../src/tray-window-runtime.ts'

const validTrayPayload = () => ({
  generation: 3,
  threads: [{ id: 'thread-1', title: '会话', updatedAt: 1 }],
  currentThreadId: 'thread-outside-recent-list',
})

test('tray payload validator accepts a bounded snapshot and rejects every security boundary', () => {
  assert.deepEqual(validateTrayStatePayload(validTrayPayload(), 3), {
    ok: true,
    value: {
      threads: [{ id: 'thread-1', title: '会话', updatedAt: 1 }],
      currentThreadId: 'thread-outside-recent-list',
    },
  })

  const cases = [
    [null, 'invalid_payload'],
    [{ ...validTrayPayload(), generation: 2 }, 'stale_generation'],
    [{ ...validTrayPayload(), threads: Array.from({ length: 6 }, (_, index) => ({ id: String(index), title: '', updatedAt: 1 })) }, 'invalid_threads'],
    [{ ...validTrayPayload(), threads: [{ id: 'same', title: '', updatedAt: 1 }, { id: 'same', title: '', updatedAt: 2 }] }, 'invalid_thread_id'],
    [{ ...validTrayPayload(), threads: [{ id: '', title: '', updatedAt: 1 }] }, 'invalid_thread_id'],
    [{ ...validTrayPayload(), threads: [{ id: 'x'.repeat(129), title: '', updatedAt: 1 }] }, 'invalid_thread_id'],
    [{ ...validTrayPayload(), threads: [{ id: 'one', title: 'x'.repeat(257), updatedAt: 1 }] }, 'invalid_thread_title'],
    [{ ...validTrayPayload(), threads: [{ id: 'one', title: '', updatedAt: Number.NaN }] }, 'invalid_thread_updated_at'],
    [{ ...validTrayPayload(), currentThreadId: '' }, 'invalid_current_thread_id'],
    [{ ...validTrayPayload(), padding: 'x'.repeat(9_000) }, 'payload_too_large'],
  ]
  for (const [payload, reason] of cases) {
    assert.deepEqual(validateTrayStatePayload(payload, 3), { ok: false, reason })
  }
})

test('main-window sender matching excludes auxiliary and missing renderers', () => {
  assert.equal(isMainWindowSender(11, 11), true)
  assert.equal(isMainWindowSender(11, 12), false)
  assert.equal(isMainWindowSender(null, 11), false)
})

test('tray rejection logs are bounded per key and recover with a suppressed count', () => {
  let now = 1_000
  const limiter = createEventRateLimiter({ windowMs: 10_000, now: () => now })
  assert.deepEqual(limiter.record('tray.sync_rejected:11:3'), { allowed: true, suppressedCount: 0 })
  assert.deepEqual(limiter.record('tray.sync_rejected:11:3'), { allowed: false, suppressedCount: 1 })
  assert.deepEqual(limiter.record('tray.sender_rejected:11:3'), { allowed: true, suppressedCount: 0 })
  now += 10_000
  assert.deepEqual(limiter.record('tray.sync_rejected:11:3'), { allowed: true, suppressedCount: 1 })
})

test('main-window lifecycle keeps navigation and revisions generation-scoped', () => {
  const lifecycle = createMainWindowLifecycleState()
  const first = lifecycle.beginGeneration()
  assert.equal(first, 1)
  assert.deepEqual(lifecycle.queueNavigation(first, { action: 'new-thread' }), { accepted: true, replaced: false })
  assert.deepEqual(lifecycle.queueNavigation(first, { action: 'open-settings' }), { accepted: true, replaced: true })
  assert.equal(lifecycle.acceptWindowBehaviorRevision(first, 0), true)
  assert.equal(lifecycle.acceptWindowBehaviorRevision(first, 0), false)

  const second = lifecycle.beginGeneration()
  assert.equal(lifecycle.acceptWindowBehaviorRevision(second, 0), true)
  assert.equal(lifecycle.closeGeneration(first), false)
  assert.equal(lifecycle.getPendingNavigation(), null)
  assert.deepEqual(lifecycle.markRendererReady(first), { accepted: false, payload: null })
  assert.deepEqual(lifecycle.queueNavigation(second, { action: 'open-thread', threadId: 'two' }), { accepted: true, replaced: false })
  assert.deepEqual(lifecycle.markRendererReady(second), { accepted: true, payload: { action: 'open-thread', threadId: 'two' } })
  assert.equal(lifecycle.isRendererReady(second), true)
  assert.equal(lifecycle.closeGeneration(second), true)
  assert.equal(lifecycle.isRendererReady(second), false)
})

test('single-flight creation shares concurrent work and permits a later recreation', async () => {
  const singleFlight = createAsyncSingleFlight()
  let calls = 0
  let release
  const first = singleFlight.run(() => {
    calls += 1
    return new Promise((resolve) => { release = resolve })
  })
  const concurrent = singleFlight.run(() => {
    calls += 1
    return Promise.resolve('wrong')
  })
  assert.equal(first, concurrent)
  await Promise.resolve()
  assert.equal(calls, 1)
  release('first')
  assert.equal(await first, 'first')
  assert.equal(await singleFlight.run(() => {
    calls += 1
    return 'second'
  }), 'second')
  assert.equal(calls, 2)

  await assert.rejects(singleFlight.run(() => { throw new Error('synchronous failure') }), /synchronous failure/)
  assert.equal(await singleFlight.run(() => 'recovered'), 'recovered')
})

test('close-before-ready is handled immediately and a later window can become ready', async () => {
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    const firstWindow = new EventEmitter()
    const firstReady = waitForWindowReady(firstWindow, 1_000)
    const firstCreation = Promise.all([Promise.resolve(), firstReady])
    firstWindow.emit('closed')
    await assert.rejects(firstCreation, /closed before ready/)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])

    const secondWindow = new EventEmitter()
    const secondReady = waitForWindowReady(secondWindow, 1_000)
    secondWindow.emit('ready-to-show')
    await secondReady
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('tray destruction failures stay controlled and expose the fallback path', () => {
  const errors = []
  const result = destroyTrayWithFallback(() => { throw new Error('native destroy failed') }, (error) => errors.push(error))
  assert.equal(result, false)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /native destroy failed/)
})
