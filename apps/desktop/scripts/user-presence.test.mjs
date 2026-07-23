import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchesDesktopHostManifest, nativeWindowHandleValue } from '../src/user-presence'

const roots = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true })
})

describe('user-presence helper boundary', () => {
  test('decodes Electron native window handles without precision loss', () => {
    expect(nativeWindowHandleValue(Buffer.from([0x78, 0x56, 0x34, 0x12]))).toBe(0x12345678n)
    expect(nativeWindowHandleValue(Buffer.from([0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01]))).toBe(0x0123456789abcdefn)
    expect(nativeWindowHandleValue(Buffer.alloc(8))).toBeNull()
    expect(nativeWindowHandleValue(Buffer.alloc(3))).toBeNull()
  })

  test('accepts only the exact helper hash and binary name from the trusted manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'lume-user-presence-'))
    roots.push(root)
    const binaryPath = join(root, 'lume_desktop_host.exe')
    const manifestPath = join(root, 'desktop-host-manifest.json')
    const binary = Buffer.from('trusted helper')
    writeFileSync(binaryPath, binary)
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      targets: {
        'win32-x64-msvc': {
          binary: 'lume_desktop_host.exe',
          sha256: createHash('sha256').update(binary).digest('hex'),
        },
      },
    }))

    expect(matchesDesktopHostManifest({ binaryPath, manifestPath, targetId: 'win32-x64-msvc' })).toBe(true)
    writeFileSync(binaryPath, 'replaced helper')
    expect(matchesDesktopHostManifest({ binaryPath, manifestPath, targetId: 'win32-x64-msvc' })).toBe(false)
    expect(matchesDesktopHostManifest({ binaryPath, manifestPath, targetId: 'darwin-arm64' })).toBe(false)
  })
})
