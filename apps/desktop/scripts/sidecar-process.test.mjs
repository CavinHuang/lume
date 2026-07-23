import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import {
  createDesktopHostSpawnConfig,
  createUtilityProcessSidecarForkConfig,
  getDesktopHostBinaryPath,
  getUserPresenceHelperPath,
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

test('getUserPresenceHelperPath reuses the Windows host and selects the macOS helper', () => {
  assert.equal(
    getUserPresenceHelperPath({
      appIsPackaged: true,
      resourcesPath: 'C:/Program Files/Lume/resources',
      desktopRoot: 'D:/repo/apps/desktop',
      platform: 'win32',
      arch: 'x64',
    }),
    join('C:/Program Files/Lume/resources', 'desktop-host', 'win32-x64-msvc', 'lume_desktop_host.exe'),
  )
  assert.equal(
    getUserPresenceHelperPath({
      appIsPackaged: true,
      resourcesPath: '/Applications/Lume.app/Contents/Resources',
      desktopRoot: '/repo/apps/desktop',
      platform: 'darwin',
      arch: 'arm64',
    }),
    join('/Applications/Lume.app/Contents/Resources', 'desktop-host', 'darwin-arm64', 'Lume Computer Use.app', 'Contents', 'MacOS', 'LumeUserPresence'),
  )
})

test('createDesktopHostSpawnConfig passes endpoint and session token without shell execution', () => {
  assert.deepEqual(
    createDesktopHostSpawnConfig({
      binaryPath: 'C:/Lume/lume_desktop_host.exe',
      endpoint: '\\\\.\\pipe\\lume-desktop-123',
      sessionToken: 'secret-token',
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
