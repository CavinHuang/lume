import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import {
  createDesktopHostSpawnConfig,
  createUtilityProcessSidecarForkConfig,
  getBundledRipgrepPath,
  getDesktopHostBinaryPath,
  getNativeBinaryPath,
  getNativeTargetId,
  getNodeReplHostBinaryPath,
  getNodeReplRootPath,
  getSidecarScriptPath,
} from '../src/sidecar-process.ts'

test('getSidecarScriptPath resolves packaged sidecar bundle from Electron resources', () => {
  assert.equal(
    getSidecarScriptPath({
      appIsPackaged: true,
      resourcesPath: '/opt/Lume/resources',
      desktopRoot: '/repo/apps/desktop',
    }),
    join('/opt/Lume/resources', 'sidecar', 'index.mjs'),
  )
})

test('getSidecarScriptPath resolves dev sidecar bundle from desktop resources', () => {
  assert.equal(
    getSidecarScriptPath({
      appIsPackaged: false,
      resourcesPath: '/unused',
      desktopRoot: '/repo/apps/desktop',
    }),
    resolve('/repo/apps/desktop', 'resources', 'sidecar', 'index.mjs'),
  )
})

test('getNativeTargetId resolves supported Electron native targets', () => {
  assert.equal(getNativeTargetId({ platform: 'win32', arch: 'x64' }), 'win32-x64-msvc')
  assert.equal(getNativeTargetId({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64')
  assert.equal(getNativeTargetId({ platform: 'linux', arch: 'arm64' }), 'linux-arm64-gnu')
})

test('getNativeBinaryPath resolves packaged native binary from Electron resources', () => {
  assert.equal(
    getNativeBinaryPath({
      appIsPackaged: true,
      resourcesPath: '/opt/Lume/resources',
      desktopRoot: '/repo/apps/desktop',
      platform: 'linux',
      arch: 'x64',
    }),
    join('/opt/Lume/resources', 'natives', 'linux-x64-gnu', 'lume-natives.node'),
  )
})

test('getNativeBinaryPath resolves dev native binary from desktop resources', () => {
  assert.equal(
    getNativeBinaryPath({
      appIsPackaged: false,
      resourcesPath: '/unused',
      desktopRoot: '/repo/apps/desktop',
      platform: 'win32',
      arch: 'x64',
    }),
    resolve('/repo/apps/desktop', 'resources', 'natives', 'win32-x64-msvc', 'lume-natives.node'),
  )
})

test('getBundledRipgrepPath resolves packaged ripgrep from Electron resources', () => {
  assert.equal(
    getBundledRipgrepPath({
      appIsPackaged: true,
      resourcesPath: '/opt/Lume/resources',
      desktopRoot: '/repo/apps/desktop',
      platform: 'win32',
      arch: 'x64',
    }),
    join('/opt/Lume/resources', 'ripgrep', 'win32-x64-msvc', 'rg.exe'),
  )
})

test('getBundledRipgrepPath resolves both macOS packaged targets', () => {
  assert.equal(
    getBundledRipgrepPath({
      appIsPackaged: true,
      resourcesPath: '/Applications/Lume.app/Contents/Resources',
      desktopRoot: '/repo/apps/desktop',
      platform: 'darwin',
      arch: 'x64',
    }),
    join('/Applications/Lume.app/Contents/Resources', 'ripgrep', 'darwin-x64', 'rg'),
  )
  assert.equal(
    getBundledRipgrepPath({
      appIsPackaged: true,
      resourcesPath: '/Applications/Lume.app/Contents/Resources',
      desktopRoot: '/repo/apps/desktop',
      platform: 'darwin',
      arch: 'arm64',
    }),
    join('/Applications/Lume.app/Contents/Resources', 'ripgrep', 'darwin-arm64', 'rg'),
  )
})

test('getNodeReplRootPath resolves packaged runtime directory', () => {
  assert.equal(
    getNodeReplRootPath({
      appIsPackaged: true,
      resourcesPath: '/opt/Lume/resources',
      desktopRoot: '/repo/apps/desktop',
    }),
    join('/opt/Lume/resources', 'node-repl'),
  )
})

test('getNodeReplRootPath resolves dev runtime directory from desktop resources', () => {
  assert.equal(
    getNodeReplRootPath({
      appIsPackaged: false,
      resourcesPath: '/unused',
      desktopRoot: '/repo/apps/desktop',
    }),
    resolve('/repo/apps/desktop', 'resources', 'node-repl'),
  )
})

test('getNodeReplHostBinaryPath resolves packaged host binary', () => {
  assert.equal(
    getNodeReplHostBinaryPath({
      appIsPackaged: true,
      resourcesPath: '/opt/Lume/resources',
      desktopRoot: '/repo/apps/desktop',
      platform: 'win32',
    }),
    join('/opt/Lume/resources', 'node-repl', 'bin', 'node_repl.exe'),
  )
})

test('getNodeReplHostBinaryPath resolves dev host binary', () => {
  assert.equal(
    getNodeReplHostBinaryPath({
      appIsPackaged: false,
      resourcesPath: '/unused',
      desktopRoot: '/repo/apps/desktop',
      platform: 'linux',
    }),
    resolve('/repo/apps/desktop', 'resources', 'node-repl', 'bin', 'node_repl'),
  )
})

test('getDesktopHostBinaryPath resolves target-specific packaged and dev binaries', () => {
  assert.equal(
    getDesktopHostBinaryPath({
      appIsPackaged: true,
      resourcesPath: 'C:/Program Files/Lume/resources',
      desktopRoot: 'D:/repo/apps/desktop',
      platform: 'win32',
      arch: 'x64',
    }),
    join('C:/Program Files/Lume/resources', 'desktop-host', 'win32-x64-msvc', 'lume_desktop_host.exe'),
  )
  assert.equal(
    getDesktopHostBinaryPath({
      appIsPackaged: true,
      resourcesPath: '/Applications/Lume.app/Contents/Resources',
      desktopRoot: '/repo/apps/desktop',
      platform: 'darwin',
      arch: 'arm64',
    }),
    join('/Applications/Lume.app/Contents/Resources', 'desktop-host', 'darwin-arm64', 'Lume Computer Use.app', 'Contents', 'MacOS', 'lume_desktop_host'),
  )
  assert.equal(
    getDesktopHostBinaryPath({
      appIsPackaged: false,
      resourcesPath: 'ignored',
      desktopRoot: 'D:/repo/apps/desktop',
      platform: 'darwin',
      arch: 'arm64',
    }),
    resolve('D:/repo/apps/desktop', 'resources', 'desktop-host', 'darwin-arm64', 'Lume Computer Use (Dev).app', 'Contents', 'MacOS', 'lume_desktop_host'),
  )
})

test('createDesktopHostSpawnConfig passes endpoint and session token without shell execution', () => {
  assert.deepEqual(
    createDesktopHostSpawnConfig({
      binaryPath: 'C:/Lume/lume_desktop_host.exe',
      endpoint: '\\\\.\\pipe\\lume-desktop-123',
      sessionToken: 'secret-token',
      platform: 'win32',
    }),
    {
      command: 'C:/Lume/lume_desktop_host.exe',
      args: ['--endpoint', '\\\\.\\pipe\\lume-desktop-123'],
      options: {
        env: { LUME_DESKTOP_HOST_TOKEN: 'secret-token' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    },
  )
})

test('createDesktopHostSpawnConfig launches macOS desktop host through its app bundle', () => {
  assert.deepEqual(
    createDesktopHostSpawnConfig({
      binaryPath: '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app/Contents/MacOS/lume_desktop_host',
      endpoint: '/tmp/lume-desktop.sock',
      sessionToken: 'secret-token',
      tokenFilePath: '/tmp/lume-desktop.sock.token',
      platform: 'darwin',
    }),
    {
      command: '/usr/bin/open',
      args: [
        '-n',
        '-W',
        '-g',
        '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app',
        '--args',
        '--endpoint',
        '/tmp/lume-desktop.sock',
        '--token-file',
        '/tmp/lume-desktop.sock.token',
      ],
      options: {
        env: {},
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    },
  )
})

// #751: darwin 经 LaunchServices 拉起时宿主 stdio 不达 supervisor；
// open --stdout/--stderr 把宿主日志重定向到文件，由 supervisor tail 跟随。
test('createDesktopHostSpawnConfig redirects host stdout/stderr to files when paths provided (#751)', () => {
  const config = createDesktopHostSpawnConfig({
    binaryPath: '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app/Contents/MacOS/lume_desktop_host',
    endpoint: '/tmp/lume-desktop.sock',
    sessionToken: 'secret-token',
    tokenFilePath: '/tmp/lume-desktop.sock.token',
    logStdoutPath: '/tmp/lume-host.out.log',
    logStderrPath: '/tmp/lume-host.err.log',
    platform: 'darwin',
  })
  // --stdout/--stderr 是 open 自身的选项，必须位于 app 路径之前；--args 之后才是宿主参数。
  assert.deepEqual(config.args, [
    '-n',
    '-W',
    '-g',
    '--stdout',
    '/tmp/lume-host.out.log',
    '--stderr',
    '/tmp/lume-host.err.log',
    '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Lume Computer Use.app',
    '--args',
    '--endpoint',
    '/tmp/lume-desktop.sock',
    '--token-file',
    '/tmp/lume-desktop.sock.token',
  ])
})

test('createDesktopHostSpawnConfig rejects macOS host paths outside an app bundle', () => {
  assert.throws(
    () => createDesktopHostSpawnConfig({
      binaryPath: '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/lume_desktop_host',
      endpoint: '/tmp/lume-desktop.sock',
      sessionToken: 'secret-token',
      tokenFilePath: '/tmp/lume-desktop.sock.token',
      platform: 'darwin',
    }),
    /macOS desktop host must be launched from Lume Computer Use\.app/,
  )
})

test('createDesktopHostSpawnConfig rejects unrelated macOS app bundles', () => {
  assert.throws(
    () => createDesktopHostSpawnConfig({
      binaryPath: '/Applications/Lume.app/Contents/Resources/desktop-host/darwin-arm64/Other Computer Use.app/Contents/MacOS/lume_desktop_host',
      endpoint: '/tmp/lume-desktop.sock',
      sessionToken: 'secret-token',
      tokenFilePath: '/tmp/lume-desktop.sock.token',
      platform: 'darwin',
    }),
    /macOS desktop host must be launched from Lume Computer Use\.app/,
  )
})

test('createUtilityProcessSidecarForkConfig uses Electron utility process options', () => {
  const config = createUtilityProcessSidecarForkConfig({
    sidecarScriptPath: '/Applications/Lume.app/Contents/Resources/sidecar/index.mjs',
    env: {
      LUME_CONFIG_DIR: '/Users/a/.lume',
      LUME_DEFAULT_SKILLS_ARCHIVE: '/Applications/Lume.app/Contents/Resources/default-skills.tar',
    },
  })

  assert.deepEqual(config, {
    modulePath: '/Applications/Lume.app/Contents/Resources/sidecar/index.mjs',
    args: [],
    options: {
      cwd: '/Applications/Lume.app/Contents/Resources/sidecar',
      env: {
        LUME_CONFIG_DIR: '/Users/a/.lume',
        LUME_DEFAULT_SKILLS_ARCHIVE: '/Applications/Lume.app/Contents/Resources/default-skills.tar',
      },
      serviceName: 'Lume Sidecar',
      stdio: 'pipe',
    },
  })
})
