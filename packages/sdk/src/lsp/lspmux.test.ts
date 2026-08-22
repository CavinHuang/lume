import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invalidateLspmuxCache, setLspmuxCacheTtls, setLspmuxProbeSpawn, wrapRustAnalyzerWithLspmux } from './lspmux.js'

const spawnCalls: Array<{ command: string; args: string[] }> = []
let nextExitCode: number | null = 0
let nextSpawnError: Error | undefined

class FakeChild extends EventEmitter {
  kill = () => true
}

function fakeSpawn(command: string, args: string[]): FakeChild {
  spawnCalls.push({ command, args })
  const child = new FakeChild() as any
  queueMicrotask(() => {
    if (nextSpawnError) child.emit('error', nextSpawnError)
    else child.emit('exit', nextExitCode)
  })
  return child
}

// Injected through the module seam: mocking node:child_process itself would
// pollute every other suite sharing bun's test process.
setLspmuxProbeSpawn(fakeSpawn as any)

afterEach(() => {
  nextExitCode = 0
  nextSpawnError = undefined
})

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lume-lspmux-'))
  // A plain file named `lspmux` resolves as the daemon executable; spawn is
  // mocked, so no real binary is needed.
  const shim = join(root, 'lspmux')
  await writeFile(shim, '')
  if (process.platform !== 'win32') await chmod(shim, 0o755)
  return root
}

function wrap(root: string) {
  return wrapRustAnalyzerWithLspmux({
    command: join(root, 'rust-analyzer'),
    args: [],
    cwd: root,
    enabled: true,
  })
}

describe('lspmux detection cache (#374)', () => {
  test('wraps rust-analyzer when the daemon answers and caches positive probes per cwd', async () => {
    const root = await makeWorkspace()
    try {
      setLspmuxCacheTtls({ positiveMs: 60, negativeMs: 120 })
      nextExitCode = 0
      spawnCalls.length = 0
      invalidateLspmuxCache()

      const wrapped = await wrap(root)
      expect(wrapped.lspmux).toBe(true)
      expect(wrapped.args).toEqual(['client'])
      expect(wrapped.env?.LSPMUX_SERVER).toBe(join(root, 'rust-analyzer'))
      expect(spawnCalls).toHaveLength(1)

      // Inside the positive TTL the cached "running" answer is reused.
      await wrap(root)
      expect(spawnCalls).toHaveLength(1)
    } finally {
      setLspmuxCacheTtls({ positiveMs: 30_000, negativeMs: 300_000 })
      invalidateLspmuxCache()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  test('re-probes once the positive TTL lapses', async () => {
    const root = await makeWorkspace()
    try {
      setLspmuxCacheTtls({ positiveMs: 40, negativeMs: 120_000 })
      nextExitCode = 0
      spawnCalls.length = 0
      invalidateLspmuxCache()

      await wrap(root)
      expect(spawnCalls).toHaveLength(1)
      await new Promise((resolve) => setTimeout(resolve, 70))
      await wrap(root)
      expect(spawnCalls).toHaveLength(2)
    } finally {
      setLspmuxCacheTtls({ positiveMs: 30_000, negativeMs: 300_000 })
      invalidateLspmuxCache()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  test('caches negative results for the longer window and falls back to a direct connection', async () => {
    const root = await makeWorkspace()
    try {
      setLspmuxCacheTtls({ positiveMs: 40, negativeMs: 150 })
      nextExitCode = 1
      spawnCalls.length = 0
      invalidateLspmuxCache()

      const direct = await wrap(root)
      expect(direct.lspmux).toBe(false)
      expect(direct.command).toBe(join(root, 'rust-analyzer'))
      expect(spawnCalls).toHaveLength(1)

      // Still inside the negative TTL: no new probe.
      await wrap(root)
      expect(spawnCalls).toHaveLength(1)

      await new Promise((resolve) => setTimeout(resolve, 180))
      await wrap(root)
      expect(spawnCalls).toHaveLength(2)
    } finally {
      setLspmuxCacheTtls({ positiveMs: 30_000, negativeMs: 300_000 })
      invalidateLspmuxCache()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  test('invalidation forces an immediate re-probe and cwd keys stay independent', async () => {
    const rootA = await makeWorkspace()
    const rootB = await makeWorkspace()
    try {
      setLspmuxCacheTtls({ positiveMs: 60_000, negativeMs: 300_000 })
      nextExitCode = 0
      spawnCalls.length = 0
      invalidateLspmuxCache()

      await wrap(rootA)
      await wrap(rootB)
      expect(spawnCalls).toHaveLength(2)

      // Only A's entry is dropped.
      invalidateLspmuxCache(rootA)
      await wrap(rootB)
      expect(spawnCalls).toHaveLength(2)
      await wrap(rootA)
      expect(spawnCalls).toHaveLength(3)
    } finally {
      setLspmuxCacheTtls({ positiveMs: 30_000, negativeMs: 300_000 })
      invalidateLspmuxCache()
      await rm(rootA, { recursive: true, force: true })
      await rm(rootB, { recursive: true, force: true })
    }
  }, 10_000)

  test('a failing probe counts as not running', async () => {
    const root = await makeWorkspace()
    try {
      setLspmuxCacheTtls({ positiveMs: 60_000, negativeMs: 300_000 })
      nextSpawnError = new Error('spawn failed')
      spawnCalls.length = 0
      invalidateLspmuxCache()

      const wrapped = await wrap(root)
      expect(wrapped.lspmux).toBe(false)
      expect(spawnCalls).toHaveLength(1)
    } finally {
      nextSpawnError = undefined
      setLspmuxCacheTtls({ positiveMs: 30_000, negativeMs: 300_000 })
      invalidateLspmuxCache()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
