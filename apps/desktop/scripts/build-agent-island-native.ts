#!/usr/bin/env bun
/**
 * 构建 macOS 原生灵动岛 helper。非 macOS skip。
 * 分别编译 arm64/x86_64 slice，再用 lipo 合成 universal binary，供两个 macOS 包复用。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(scriptDir, '..')
const source = resolve(appDir, '../../packages/natives/agent-island/macos-agent-island-helper.swift')
const output = resolve(appDir, 'resources/agent-island/macos-agent-island-helper')

if (process.platform !== 'darwin') {
  console.log('[agent-island-native] skipped (macOS only)')
  process.exit(0)
}
if (!existsSync(source)) throw new Error(`helper source not found: ${source}`)
mkdirSync(dirname(output), { recursive: true })
rmSync(output, { force: true })
const slices = [
  { target: 'arm64-apple-macos26.0', output: `${output}.arm64` },
  { target: 'x86_64-apple-macos26.0', output: `${output}.x86_64` },
]
try {
  for (const slice of slices) {
    execFileSync('xcrun', [
      'swiftc', '-O', '-parse-as-library', '-target', slice.target, source, '-o', slice.output,
    ], { stdio: 'inherit' })
  }
  execFileSync('xcrun', ['lipo', '-create', ...slices.map((slice) => slice.output), '-output', output], { stdio: 'inherit' })
} finally {
  for (const slice of slices) rmSync(slice.output, { force: true })
}
chmodSync(output, 0o755)
console.log(`[agent-island-native] built universal helper ${output}`)
