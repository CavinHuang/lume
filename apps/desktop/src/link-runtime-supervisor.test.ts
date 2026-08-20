import { expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import type { UtilityProcess } from 'electron'
import { createLinkRuntimeSupervisor } from './link-runtime-supervisor'

// 与源文件 OPENCONNECTOR_* 常量保持一致(未导出,此处硬编码;升级 openconnector 时需同步)
const RESOURCE = {
  version: '1.3.5',
  commit: '5719a69468c698c7cb8108e062ff64ecef8a2e65',
  archiveSha256: '4991b3a5a44ae68c57976767462f313f8d9bc1075ae0f64b314fca277e19441f',
}

class FakeUtilityProcess extends EventEmitter {
  stdout = { resume() {} }
  stderr = { resume() {} }
  pid = 4321
  killed = false
  kill() { this.killed = true; return true }
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function createHarness() {
  const configDir = mkdtempSync(join(tmpdir(), 'lume-link-config-'))
  const resourceDir = mkdtempSync(join(tmpdir(), 'lume-link-res-'))
  mkdirSync(join(resourceDir, 'catalog'), { recursive: true })
  mkdirSync(join(resourceDir, 'migrations'), { recursive: true })
  writeFileSync(join(resourceDir, 'openconnector.mjs'), '')
  writeFileSync(join(resourceDir, 'lume-resource.json'), JSON.stringify(RESOURCE))
  const port = await pickFreePort()
  mkdirSync(join(configDir, 'link-runtime'), { recursive: true })
  writeFileSync(join(configDir, 'link-runtime', 'state.json'), JSON.stringify({ enabled: true, mode: 'local', port }))
  const forks: FakeUtilityProcess[] = []
  const killProcessTree = mock((pid: number) => { void pid })
  const supervisor = createLinkRuntimeSupervisor({
    configDir,
    resourceDir,
    getMasterKey: () => Buffer.alloc(32),
    fork: (() => {
      const process = new FakeUtilityProcess()
      forks.push(process)
      return process as unknown as UtilityProcess
    }) as Parameters<typeof createLinkRuntimeSupervisor>[0]['fork'],
    emit: () => {},
    installBootstrap: async () => {},
    killProcessTree,
  })
  return { supervisor, forks, killProcessTree }
}

function patchHealthyFetch() {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ success: true, data: { ok: true, runtime: 'oomol-connect' } }),
  })) as unknown as typeof fetch
  return () => { globalThis.fetch = realFetch }
}

test('#126 并发 start 只 fork 一次,不产生孤儿进程', async () => {
  const { supervisor, forks } = await createHarness()
  const restoreFetch = patchHealthyFetch()
  try {
    const [first, second] = await Promise.all([supervisor.initialize(), supervisor.initialize()])
    expect(forks).toHaveLength(1)
    expect(first.phase).toBe('online')
    // 第二次调用被 starting 守卫早返回(不 fork),拿到的是拦截时刻的状态
    expect(second.phase).toBe('starting')
    expect(supervisor.getState().phase).toBe('online')
  } finally {
    restoreFetch()
    await supervisor.stop()
  }
})

test('#127 健康等待期内进程已退出时不再 kill/killProcessTree', async () => {
  const { supervisor, forks, killProcessTree } = await createHarness()
  const realFetch = globalThis.fetch
  // 首次健康探测到达前进程已崩溃(exit 事件先于 health 成功 flush)
  globalThis.fetch = (async () => {
    forks[0]?.emit('exit')
    return { ok: true, json: async () => ({ success: true, data: { ok: true, runtime: 'oomol-connect' } }) }
  }) as unknown as typeof fetch
  try {
    await expect(supervisor.initialize()).rejects.toThrow('link_runtime_exited_during_start')
    expect(killProcessTree).not.toHaveBeenCalled()
    expect(forks[0]?.killed).toBe(false)
  } finally {
    globalThis.fetch = realFetch
    await supervisor.stop()
  }
})

test('#187 旧 start 的 catch 不得毒化重启后的健康进程', async () => {
  const { supervisor, forks } = await createHarness()
  const realFetch = globalThis.fetch
  const healthy = () => ({ ok: true, json: async () => ({ success: true, data: { ok: true, runtime: 'oomol-connect' } }) })
  // start#1 的首次健康探测挂起；期间 fork#1 崩溃 → exit handler 调度 restartTimer(1s)
  // → start#2 fork#2 立即健康 → online；随后释放 start#1 的挂起探测（拿到的是 #2 的响应）
  let resolveFirstProbe: ((value: unknown) => void) | null = null
  let probeCount = 0
  globalThis.fetch = (async () => {
    probeCount += 1
    if (probeCount === 1) return new Promise((resolve) => { resolveFirstProbe = resolve })
    return healthy()
  }) as unknown as typeof fetch
  try {
    const firstStart = supervisor.initialize()
    // 等 start#1 进入健康轮询后击杀 fork#1
    await new Promise((resolve) => setTimeout(resolve, 50))
    forks[0]?.emit('exit')
    // 等 restartTimer(1s) 触发 start#2 并上线
    const deadline = Date.now() + 10_000
    while (supervisor.getState().phase !== 'online' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(supervisor.getState().phase).toBe('online')
    expect(forks.length).toBe(2)
    // 释放旧 start 的挂起探测：旧 start 拿到健康响应但 child 已是 #2
    resolveFirstProbe?.(healthy())
    // 修复后：旧 start 被 start#2 的代际 bump 失效，静默 resolve，不 publish crashed、不置 stopping
    const resolved = await firstStart
    expect(resolved.phase).toBe('online')
    expect(supervisor.getState().phase).toBe('online')
    expect(supervisor.getState().lastError).toBeUndefined()
  } finally {
    globalThis.fetch = realFetch
    await supervisor.stop()
  }
})
