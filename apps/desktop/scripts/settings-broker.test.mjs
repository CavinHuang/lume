import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsBroker } from '../src/settings/settings-broker.ts'

test('owns the root settings lock and serializes whole-file mutations', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-settings-broker-'))
  const broker = new SettingsBroker(configDir)
  try {
    broker.replace({ proxy: { enabled: true } })
    broker.mutate((settings) => ({ ...settings, generalSettings: { themeMode: 'dark' } }))
    assert.deepEqual(broker.read(), {
      proxy: { enabled: true },
      generalSettings: { themeMode: 'dark' },
    })
    assert.equal(existsSync(join(configDir, 'settings.json.lock')), true)
    assert.throws(() => new SettingsBroker(configDir))
  } finally {
    broker.close()
    assert.equal(existsSync(join(configDir, 'settings.json.lock')), false)
    await rm(configDir, { recursive: true, force: true })
  }
})

// #120: 崩溃落在两次 rename 之间时 .bak 是旧设置的唯一幸存副本。
test('read() falls back to .bak when settings.json is missing (#120)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-settings-bak-'))
  writeFileSync(join(configDir, 'settings.json.bak'), JSON.stringify({ theme: 'dark' }), 'utf8')
  const broker = new SettingsBroker(configDir)
  try {
    assert.deepEqual(broker.read(), { theme: 'dark' })
  } finally {
    broker.close()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('replace() keeps the surviving .bak when settings.json was missing (#120)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-settings-bak-keep-'))
  writeFileSync(join(configDir, 'settings.json.bak'), JSON.stringify({ theme: 'dark' }), 'utf8')
  const broker = new SettingsBroker(configDir)
  try {
    broker.replace({ theme: 'light' })
    assert.deepEqual(JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8')), { theme: 'light' })
    assert.equal(existsSync(join(configDir, 'settings.json.bak')), true)
    assert.deepEqual(JSON.parse(await readFile(join(configDir, 'settings.json.bak'), 'utf8')), { theme: 'dark' })
  } finally {
    broker.close()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('replace() rotates the backup away on a normal write', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-settings-bak-rotate-'))
  const broker = new SettingsBroker(configDir)
  try {
    broker.replace({ a: 1 })
    broker.replace({ a: 2 })
    assert.deepEqual(JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8')), { a: 2 })
    assert.equal(existsSync(join(configDir, 'settings.json.bak')), false)
  } finally {
    broker.close()
    await rm(configDir, { recursive: true, force: true })
  }
})

// #121: 陈旧锁的 pid 被 OS 复用给无关进程时（启动时间对不上），必须清锁而不是拒绝启动。
test('stale lock whose pid was recycled by another process is cleared (#121)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-settings-lock-recycled-'))
  writeFileSync(join(configDir, 'settings.json.lock'), JSON.stringify({
    pid: process.pid,
    processStartedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    token: 'stale',
  }), 'utf8')
  const broker = new SettingsBroker(configDir)
  broker.close()
  await rm(configDir, { recursive: true, force: true })
})

test('lock held by a live process with matching start time blocks startup (#121)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-settings-lock-live-'))
  writeFileSync(join(configDir, 'settings.json.lock'), JSON.stringify({
    pid: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    token: 'live',
  }), 'utf8')
  try {
    assert.throws(() => new SettingsBroker(configDir))
    assert.equal(existsSync(join(configDir, 'settings.json.lock')), true)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('stale lock with a dead pid is cleared', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-settings-lock-dead-'))
  writeFileSync(join(configDir, 'settings.json.lock'), JSON.stringify({
    pid: 999_999_999,
    processStartedAt: new Date().toISOString(),
    token: 'dead',
  }), 'utf8')
  const broker = new SettingsBroker(configDir)
  broker.close()
  await rm(configDir, { recursive: true, force: true })
})
