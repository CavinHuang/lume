import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createDesktopHostEndpoint,
  createDesktopHostSupervisor,
} from '../src/desktop-host-supervisor.ts'

test('createDesktopHostEndpoint uses a named pipe on Windows and a socket path on macOS', () => {
  assert.equal(
    createDesktopHostEndpoint({ platform: 'win32', id: 'abc' }),
    '\\\\.\\pipe\\lume-desktop-abc',
  )
  assert.equal(
    createDesktopHostEndpoint({ platform: 'darwin', id: 'abc', tempDir: '/tmp' }),
    '/tmp/lume-desktop-abc.sock',
  )
})

test('missing desktop host degrades without spawning or throwing', async () => {
  let spawned = false
  const supervisor = createDesktopHostSupervisor({
    binaryPath: 'missing-host',
    exists: () => false,
    spawn: () => { spawned = true; throw new Error('should not spawn') },
    id: () => 'id-1',
    token: () => 'token-1',
    platform: 'win32',
  })

  assert.deepEqual(await supervisor.start(), {
    available: false,
    reason: 'desktop host binary is missing: missing-host',
  })
  assert.equal(spawned, false)
})

test('starts the host with an isolated endpoint and exports connection metadata', async () => {
  const child = new EventEmitter()
  child.kill = () => true
  let spawnInput
  const supervisor = createDesktopHostSupervisor({
    binaryPath: 'C:/Lume/lume_desktop_host.exe',
    exists: () => true,
    spawn: (command, args, options) => {
      spawnInput = { command, args, options }
      return child
    },
    id: () => 'id-2',
    token: () => 'token-2',
    platform: 'win32',
  })

  const result = await supervisor.start()
  assert.deepEqual(result, {
    available: true,
    endpoint: '\\\\.\\pipe\\lume-desktop-id-2',
    token: 'token-2',
  })
  assert.equal(spawnInput.command, 'C:/Lume/lume_desktop_host.exe')
  assert.deepEqual(spawnInput.args, ['--endpoint', '\\\\.\\pipe\\lume-desktop-id-2'])
  assert.equal(spawnInput.options.env.LUME_DESKTOP_HOST_TOKEN, 'token-2')
  assert.equal(spawnInput.options.windowsHide, true)
})

test('starts macOS host through the app bundle with a private token file', async () => {
  const child = new EventEmitter()
  child.kill = () => true
  let spawnInput
  let tokenWrite
  const supervisor = createDesktopHostSupervisor({
    binaryPath: '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app/Contents/MacOS/lume_desktop_host',
    exists: () => true,
    spawn: (command, args, options) => {
      spawnInput = { command, args, options }
      return child
    },
    writeTokenFile: (path, token) => { tokenWrite = { path, token } },
    id: () => 'mac-id',
    token: () => 'mac-token',
    tempDir: '/tmp',
    platform: 'darwin',
  })

  const result = await supervisor.start()
  assert.deepEqual(result, {
    available: true,
    endpoint: '/tmp/lume-desktop-mac-id.sock',
    token: 'mac-token',
  })
  assert.deepEqual(tokenWrite, {
    path: '/tmp/lume-desktop-mac-id.sock.token',
    token: 'mac-token',
  })
  assert.equal(spawnInput.command, '/usr/bin/open')
  assert.deepEqual(spawnInput.args, [
    '-n',
    '-W',
    '-g',
    '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app',
    '--args',
    '--endpoint',
    '/tmp/lume-desktop-mac-id.sock',
    '--token-file',
    '/tmp/lume-desktop-mac-id.sock.token',
  ])
  assert.equal(spawnInput.options.env.LUME_DESKTOP_HOST_TOKEN, undefined)
})

test('restarts a crashed host with backoff on the same endpoint', async () => {
  const children = []
  const scheduled = []
  const supervisor = createDesktopHostSupervisor({
    binaryPath: 'C:/Lume/lume_desktop_host.exe',
    exists: () => true,
    spawn: () => {
      const child = new EventEmitter()
      child.kill = () => true
      children.push(child)
      return child
    },
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay })
      return 1
    },
    cancelSchedule: () => {},
    id: () => 'stable',
    token: () => 'token',
    platform: 'win32',
  })

  await supervisor.start()
  children[0].emit('exit', 1)
  assert.equal(scheduled[0].delay, 500)
  scheduled[0].callback()
  assert.equal(children.length, 2)
})
