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
  const spawnInput = { command: '', args: [], options: {} }
  let tokenWrite
  const supervisor = createDesktopHostSupervisor({
    binaryPath: '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app/Contents/MacOS/lume_desktop_host',
    exists: () => true,
    spawn: (command, args, options) => {
      // 只捕获 open 进程；#751 的 tail 跟随者有专测覆盖。
      if (command === '/usr/bin/open') {
        spawnInput.command = command
        spawnInput.args = args
        spawnInput.options = options
      }
      return child
    },
    writeTokenFile: (path, token) => { tokenWrite = { path, token } },
    touchFile: () => {},
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
    '--stdout',
    '/tmp/lume-desktop-mac-id.sock.token.stdout.log',
    '--stderr',
    '/tmp/lume-desktop-mac-id.sock.token.stderr.log',
    '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app',
    '--args',
    '--endpoint',
    '/tmp/lume-desktop-mac-id.sock',
    '--token-file',
    '/tmp/lume-desktop-mac-id.sock.token',
  ])
  assert.equal(spawnInput.options.env.LUME_DESKTOP_HOST_TOKEN, undefined)
})

// #751: darwin 经 LaunchServices 拉起，宿主 stdio 归 /dev/null——supervisor 用
// open --stdout/--stderr 重定向到文件 + tail -F 跟随，恢复 LUMELOG 结构化行摄取。
test('macOS start redirects host logs to files and follows them via tail (#751)', async () => {
  const spawns = []
  const tails = []
  const child = new EventEmitter()
  child.kill = () => true
  const touched = []
  const removed = []
  const logLines = []
  const loggedEvents = []
  const supervisor = createDesktopHostSupervisor({
    binaryPath: '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app/Contents/MacOS/lume_desktop_host',
    exists: () => true,
    spawn: (command, args) => {
      if (command === '/usr/bin/tail') {
        const tail = new EventEmitter()
        tail.stdout = new EventEmitter()
        tail.kill = () => { tails.killed = (tails.killed ?? 0) + 1; return true }
        tails.push({ command, args, process: tail })
        return tail
      }
      const proc = command === '/usr/bin/open' ? child : new EventEmitter()
      proc.kill = proc.kill ?? (() => true)
      spawns.push({ command, args })
      return proc
    },
    writeTokenFile: () => {},
    removeTokenFile: (path) => { removed.push(path) },
    touchFile: (path) => { touched.push(path) },
    id: () => 'mac-log-id',
    token: () => 'mac-token',
    tempDir: '/tmp',
    platform: 'darwin',
    log: (message) => { logLines.push(message) },
    logEvent: (event) => { loggedEvents.push(event) },
  })

  await supervisor.start()
  // open 带重定向旗标；随后两条 tail -F 跟随输出文件（路径锚定 token 文件名）。
  assert.equal(spawns.length, 1)
  assert.deepEqual(spawns[0].args.slice(0, 8), [
    '-n', '-W', '-g', '--stdout',
    '/tmp/lume-desktop-mac-log-id.sock.token.stdout.log',
    '--stderr',
    '/tmp/lume-desktop-mac-log-id.sock.token.stderr.log',
    '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app',
  ])
  assert.equal(tails.length, 2)
  assert.deepEqual(touched.sort(), [
    '/tmp/lume-desktop-mac-log-id.sock.token.stderr.log',
    '/tmp/lume-desktop-mac-log-id.sock.token.stdout.log',
  ])
  // tail 从文件当前末尾起步跟随（-n0），重启场景不重复摄取历史行。
  assert.deepEqual(tails[0].args, ['-n0', '-F', '/tmp/lume-desktop-mac-log-id.sock.token.stdout.log'])
  assert.deepEqual(tails[1].args, ['-n0', '-F', '/tmp/lume-desktop-mac-log-id.sock.token.stderr.log'])

  // tail stdout 收到 LUMELOG 结构化行 → logEvent；非前缀行 → 文本回退。
  const stdoutTail = tails[0].process
  stdoutTail.stdout.emit('data', Buffer.from('LUMELOG {"level":"warn","context":"c","event":"e","message":"m"}\n'))
  stdoutTail.stdout.emit('data', Buffer.from('[host] plain text line\n'))
  assert.equal(loggedEvents.length, 1)
  assert.equal(loggedEvents[0].message, 'm')
  assert.ok(logLines.some((line) => line.includes('plain text line')))

  // stop() 必须回收 tail 进程（否则重启后旧 -F 与新 tail 双跟重复摄取）。
  supervisor.stop()
  assert.ok((tails.killed ?? 0) >= 2, `stop should kill both tails, got ${tails.killed}`)
  assert.deepEqual(removed.sort(), [
    '/tmp/lume-desktop-mac-log-id.sock.token',
    '/tmp/lume-desktop-mac-log-id.sock.token.stderr.log',
    '/tmp/lume-desktop-mac-log-id.sock.token.stdout.log',
  ])
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
  assert.equal(scheduled[0].delay, 1000)
  scheduled[0].callback()
  assert.equal(children.length, 2)
})
