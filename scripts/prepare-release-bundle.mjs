#!/usr/bin/env bun

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const binariesDir = join(root, 'apps/desktop/src-tauri/binaries')
const sidecarEntry = join(root, 'apps/sidecar/src/index.ts')
const webDist = join(root, 'apps/web/dist')
const sidecarDist = join(root, 'apps/sidecar/dist/index.js')

const target = process.env.TAURI_TARGET ?? detectTargetTriple()
const exe = target.includes('windows') ? '.exe' : ''
const sidecarOutput = join(binariesDir, `lume-sidecar-${target}${exe}`)

console.log(`[release] preparing Lume release bundle for ${target}`)

assertExists(sidecarEntry, 'sidecar entry')
assertExists(webDist, 'web dist')
assertExists(sidecarDist, 'sidecar dist')

rmSync(binariesDir, { recursive: true, force: true })
mkdirSync(binariesDir, { recursive: true })

run('bun', [
  'build',
  sidecarEntry,
  '--compile',
  '--outfile',
  sidecarOutput,
])

assertExists(sidecarOutput, 'compiled sidecar binary')

console.log('[release] bundle input is ready')
console.log(`[release] sidecar binary: ${sidecarOutput}`)
console.log(`[release] web dist: ${webDist}`)
console.log(`[release] sidecar dist: ${sidecarDist}`)

function detectTargetTriple() {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  }

  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  }

  if (process.arch === 'arm64') {
    return 'aarch64-unknown-linux-gnu'
  }

  return 'x86_64-unknown-linux-gnu'
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`[release] ${label} not found: ${path}`)
  }
}

function run(command, args) {
  console.log(`[release] $ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: root,
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
