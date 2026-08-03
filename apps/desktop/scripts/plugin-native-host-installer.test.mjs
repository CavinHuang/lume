import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  createChromeNativeHostInstallPlan,
  writeChromeNativeHostRegistration,
} from '../src/plugin-native-host-installer.ts'

const installer = {
  kind: 'chrome-native-host',
  hostName: 'com.lume.browser',
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  appServerUrl: 'ws://127.0.0.1:43127/browser',
}

test('creates a per-user Windows Native Messaging registration plan', () => {
  const plan = createChromeNativeHostInstallPlan({
    installer,
    version: '0.4.0',
    configRoot: 'C:\\Users\\A\\.lume',
    homeDir: 'C:\\Users\\A',
    localAppData: 'C:\\Users\\A\\AppData\\Local',
    platform: 'win32',
  })
  assert.equal(plan.hostPath, 'C:\\Users\\A\\.lume\\native-hosts\\com.lume.browser\\0.4.0\\lume-chrome-host.exe')
  assert.equal(plan.manifestPath, 'C:\\Users\\A\\AppData\\Local\\Lume\\ChromeNativeMessaging\\com.lume.browser.json')
  assert.equal(plan.registry?.command, 'reg')
  assert.match(plan.registry?.args.join(' ') ?? '', /HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.lume\.browser/)
})

test('writes the macOS host config and Chrome manifest beside a prepared binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'lume-native-host-install-'))
  try {
    const plan = createChromeNativeHostInstallPlan({
      installer,
      version: '0.4.0',
      configRoot: join(root, '.lume'),
      homeDir: root,
      platform: 'darwin',
    })
    mkdirSync(dirname(plan.hostPath), { recursive: true })
    writeFileSync(plan.hostPath, 'binary')
    writeChromeNativeHostRegistration(plan)
    assert.equal(existsSync(plan.configPath), true)
    assert.equal(existsSync(plan.manifestPath), true)
    assert.deepEqual(JSON.parse(readFileSync(plan.manifestPath, 'utf8')).allowed_origins, [
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
    ])
    assert.equal(dirname(plan.configPath), dirname(plan.hostPath))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects remote app server URLs', () => {
  assert.throws(() => createChromeNativeHostInstallPlan({
    installer: { ...installer, appServerUrl: 'wss://example.com/browser' },
    version: '0.4.0',
    configRoot: '/tmp/lume',
    homeDir: '/tmp/home',
    platform: 'linux',
  }), /loopback WebSocket/)
})

test('rejects invalid Chrome Native Messaging host names', () => {
  for (const hostName of ['com.lume-browser', '.', '..', '.com.lume', 'com..lume', 'com.lume.']) {
    assert.throws(() => createChromeNativeHostInstallPlan({
      installer: { ...installer, hostName },
      version: '0.4.0',
      configRoot: '/tmp/lume',
      homeDir: '/tmp/home',
      platform: 'linux',
    }), /invalid native host name/)
  }
})
