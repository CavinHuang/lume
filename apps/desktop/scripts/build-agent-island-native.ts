#!/usr/bin/env bun
/**
 * 构建 macOS 原生灵动岛 helper。非 macOS skip。
 *
 * 待 macOS 核对：universal binary（arm64 + x86_64）需两次编译 + `lipo create`，
 * 或 `swiftc -arch arm64 -arch x86_64`。当前仅编 arm64 单架构（与 Proma 一致），
 * multi-arch 参数留待 macOS 上核对后补全。
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
// 当前仅 arm64 单架构；universal binary 参数待 macOS 核对
execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library',
  '-target', 'arm64-apple-macos26.0', source, '-o', output], { stdio: 'inherit' })
chmodSync(output, 0o755)
console.log(`[agent-island-native] built ${output}`)
