import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLinkRuntimeSupervisor, nextLinkCrashState, waitForLinkHealth } from '../src/link-runtime-supervisor.ts'

test('Link runtime allows only two automatic restarts after three crashes in five minutes', () => {
  const now = 1_000_000
  const first = nextLinkCrashState([], now)
  const second = nextLinkCrashState(first.crashTimes, now + 1_000)
  const third = nextLinkCrashState(second.crashTimes, now + 2_000)
  assert.equal(first.shouldRestart, true)
  assert.equal(second.shouldRestart, true)
  assert.equal(third.shouldRestart, false)
  assert.deepEqual([first.delayMs, second.delayMs], [1000, 2000])
})

test('Link runtime is disabled by default and emits no credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lume-link-runtime-'))
  const bootstraps = []
  try {
    const supervisor = createLinkRuntimeSupervisor({ configDir: root, resourceDir: join(root, 'missing'), getMasterKey: () => null, fork: () => { throw new Error('must not fork') }, emit: () => {}, installBootstrap: (value) => { bootstraps.push(value) }, killProcessTree: () => {} })
    const state = await supervisor.initialize()
    assert.equal(state.phase, 'disabled')
    assert.deepEqual(bootstraps, [{ mode: 'local', phase: 'disabled' }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('existing deployment mode connects without starting the bundled service and restores on launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lume-link-remote-'))
  const originalFetch = globalThis.fetch
  const bootstraps = []
  let forkCount = 0
  try {
    globalThis.fetch = async () => Response.json({ success: true, data: { ok: true, runtime: 'oomol-connect' } })
    const options = {
      configDir: root,
      resourceDir: join(root, 'missing'),
      getMasterKey: () => Buffer.alloc(32, 9),
      fork: () => { forkCount += 1; throw new Error('remote mode must not fork') },
      emit: () => {},
      installBootstrap: (value) => { bootstraps.push(value) },
      killProcessTree: () => {},
    }
    const supervisor = createLinkRuntimeSupervisor(options)
    const configured = await supervisor.configure({
      mode: 'remote',
      origin: 'https://connector.example.test/',
      adminToken: 'admin-secret',
      runtimeToken: 'runtime-secret',
    })
    assert.equal(configured.mode, 'remote')
    assert.equal(configured.phase, 'online')
    assert.equal(configured.origin, 'https://connector.example.test')
    assert.equal(configured.remoteOrigin, 'https://connector.example.test')
    assert.equal(configured.adminTokenConfigured, true)
    assert.equal(configured.runtimeTokenConfigured, true)
    assert.equal(forkCount, 0)
    assert.deepEqual(bootstraps.at(-1), {
      mode: 'remote',
      phase: 'online',
      origin: 'https://connector.example.test',
      adminToken: 'admin-secret',
      runtimeToken: 'runtime-secret',
    })
    const stored = readFileSync(join(root, 'link-runtime', 'remote-secrets.json'), 'utf8')
    assert.equal(stored.includes('admin-secret'), false)
    assert.equal(stored.includes('runtime-secret'), false)

    const local = await supervisor.configure({ mode: 'local' })
    assert.equal(local.mode, 'local')
    assert.equal(local.phase, 'incompatible')
    const reconnected = await supervisor.configure({ mode: 'remote', origin: 'https://connector.example.test' })
    assert.equal(reconnected.adminTokenConfigured, true)
    assert.equal(reconnected.runtimeTokenConfigured, true)
    assert.equal(bootstraps.at(-1).adminToken, 'admin-secret')
    assert.equal(bootstraps.at(-1).runtimeToken, 'runtime-secret')

    const restored = createLinkRuntimeSupervisor(options)
    const restoredState = await restored.initialize()
    assert.equal(restoredState.phase, 'online')
    assert.equal(restoredState.mode, 'remote')
    assert.equal(forkCount, 0)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})

test('existing deployment rejects plaintext non-loopback origins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lume-link-remote-origin-'))
  try {
    const supervisor = createLinkRuntimeSupervisor({ configDir: root, resourceDir: join(root, 'missing'), getMasterKey: () => Buffer.alloc(32), fork: () => { throw new Error('must not fork') }, emit: () => {}, installBootstrap: () => {}, killProcessTree: () => {} })
    await assert.rejects(supervisor.configure({ mode: 'remote', origin: 'http://connector.example.test' }), /invalid_link_remote_origin/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('existing deployment accepts bracketed IPv6 loopback origins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lume-link-remote-ipv6-'))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ success: true, data: { ok: true, runtime: 'oomol-connect' } })
    const supervisor = createLinkRuntimeSupervisor({ configDir: root, resourceDir: join(root, 'missing'), getMasterKey: () => Buffer.alloc(32), fork: () => { throw new Error('must not fork') }, emit: () => {}, installBootstrap: () => {}, killProcessTree: () => {} })
    const state = await supervisor.configure({ mode: 'remote', origin: 'http://[::1]:51234' })
    assert.equal(state.origin, 'http://[::1]:51234')
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})

test('Link health requires the expected JSON contract', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(null, { status: 204 })
    await assert.rejects(waitForLinkHealth('https://connector.example.test', '', 20), /link_health_timeout/)
    globalThis.fetch = async () => Response.json({ success: true, data: { ok: true, runtime: 'oomol-connect' } })
    await waitForLinkHealth('https://connector.example.test', '', 20)
  } finally { globalThis.fetch = originalFetch }
})

test('Link health aborts a stalled request at the startup deadline', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
    const startedAt = Date.now()
    await assert.rejects(waitForLinkHealth('https://connector.example.test', '', 30), /link_health_timeout/)
    assert.ok(Date.now() - startedAt < 500)
  } finally { globalThis.fetch = originalFetch }
})

test('Link runtime reports a persisted port conflict without silently switching ports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lume-link-port-'))
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  const port = address.port
  try {
    mkdirSync(join(root, 'link-runtime'), { recursive: true })
    writeFileSync(join(root, 'link-runtime', 'state.json'), JSON.stringify({ enabled: true, port }))
    const supervisor = createLinkRuntimeSupervisor({ configDir: root, resourceDir: join(root, 'missing'), getMasterKey: () => Buffer.alloc(32), fork: () => { throw new Error('must not fork') }, emit: () => {}, installBootstrap: () => {}, killProcessTree: () => {} })
    const state = await supervisor.initialize()
    assert.equal(state.phase, 'port_conflict')
    assert.equal(state.port, port)
  } finally { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }) }
})

test('Link runtime reports missing pinned resources as incompatible when enabling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lume-link-incompatible-'))
  try {
    const supervisor = createLinkRuntimeSupervisor({ configDir: root, resourceDir: join(root, 'missing'), getMasterKey: () => Buffer.alloc(32), fork: () => { throw new Error('must not fork') }, emit: () => {}, installBootstrap: () => {}, killProcessTree: () => {} })
    const state = await supervisor.enable()
    assert.equal(state.phase, 'incompatible')
    assert.equal(state.enabled, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Link runtime reaches health, keeps its stable port, and shuts down cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lume-link-shutdown-'))
  const resourceDir = join(root, 'openconnector')
  const portProbe = createServer()
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve))
  const address = portProbe.address()
  assert.equal(typeof address, 'object')
  const port = address.port
  await new Promise((resolve) => portProbe.close(resolve))
  mkdirSync(join(root, 'link-runtime'), { recursive: true })
  // bundle 形态:对齐 link-runtime-supervisor readMetadata(检查 openconnector.mjs + catalog + migrations)。
  for (const directory of ['catalog', 'migrations']) mkdirSync(join(resourceDir, directory), { recursive: true })
  writeFileSync(join(resourceDir, 'openconnector.mjs'), '')
  writeFileSync(join(resourceDir, 'lume-resource.json'), JSON.stringify({ version: '1.3.5', commit: '5719a69468c698c7cb8108e062ff64ecef8a2e65', archiveSha256: '4991b3a5a44ae68c57976767462f313f8d9bc1075ae0f64b314fca277e19441f' }))
  writeFileSync(join(root, 'link-runtime', 'state.json'), JSON.stringify({ enabled: true, port }))
  const originalFetch = globalThis.fetch
  const emitted = []
  const bootstraps = []
  let killed = false
  try {
    globalThis.fetch = async () => Response.json({ success: true, data: { ok: true, runtime: 'oomol-connect' } })
    const process = new EventEmitter()
    process.pid = 12345
    process.stdout = { resume: () => {} }
    process.stderr = { resume: () => {} }
    process.kill = () => {
      killed = true
      queueMicrotask(() => process.emit('exit', 0))
      return true
    }
    const supervisor = createLinkRuntimeSupervisor({
      configDir: root,
      resourceDir,
      getMasterKey: () => Buffer.alloc(32, 7),
      fork: (_modulePath, _args, options) => {
        assert.equal(options.env.NODE_ENV, 'production')
        assert.equal(options.env.HOST, '127.0.0.1')
        assert.equal(options.env.PORT, String(port))
        assert.equal(options.env.OOMOL_CONNECT_ORIGIN, `http://127.0.0.1:${port}`)
        assert.equal(options.env.OOMOL_CONNECT_DATA_DIR, join(root, 'link-runtime', 'openconnector', 'data'))
        assert.equal(typeof options.env.OOMOL_CONNECT_ENCRYPTION_KEY, 'string')
        assert.equal(typeof options.env.OOMOL_CONNECT_ADMIN_TOKEN, 'string')
        assert.equal(typeof options.env.OOMOL_CONNECT_RUNTIME_TOKEN, 'string')
        assert.equal(options.env.OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK, 'false')
        assert.equal(options.env.DATA_DIR, undefined)
        assert.equal(options.env.ENCRYPTION_KEY, undefined)
        assert.equal(options.env.ADMIN_TOKEN, undefined)
        assert.equal(options.env.RUNTIME_TOKEN, undefined)
        return process
      },
      emit: (state) => emitted.push(state),
      installBootstrap: (value) => { bootstraps.push(value) },
      killProcessTree: () => { throw new Error('graceful shutdown should not need a tree kill') },
    })
    const online = await supervisor.initialize()
    assert.equal(online.phase, 'online')
    assert.equal(online.port, port)
    assert.equal(Object.hasOwn(online, 'runtimeToken'), false)
    const diagnostic = await supervisor.diagnose()
    assert.equal(diagnostic.endpointReachable, true)
    assert.equal(diagnostic.resourceReady, true)
    assert.equal(Object.hasOwn(diagnostic, 'runtimeToken'), false)
    assert.equal(Object.hasOwn(diagnostic, 'adminToken'), false)
    const stopped = await supervisor.stop('offline')
    assert.equal(stopped.phase, 'offline')
    assert.equal(stopped.port, port)
    assert.equal(killed, true)
    assert.equal(bootstraps.at(-1).phase, 'offline')
    assert.equal(emitted.some((state) => Object.hasOwn(state, 'adminToken')), false)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})
