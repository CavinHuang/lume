import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import {
  createUtilityProcessSidecarForkConfig,
  getNativeBinaryPath,
  getNativeTargetId,
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
