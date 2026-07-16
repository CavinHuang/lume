import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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
