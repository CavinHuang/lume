import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateDesktopContextKey } from '../src/desktop-context-key.ts'

test('wraps a generated desktop context key and reuses it across launches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lume-context-key-'))
  const path = join(dir, 'nested', 'key.bin')
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`wrapped:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').slice('wrapped:'.length),
  }
  try {
    const first = loadOrCreateDesktopContextKey({
      path,
      safeStorage,
      randomBytes: () => Buffer.alloc(32, 9),
    })
    assert.equal(first.length, 32)
    assert.notEqual(readFileSync(path).toString('utf8'), first.toString('base64'))

    const second = loadOrCreateDesktopContextKey({
      path,
      safeStorage,
      randomBytes: () => { throw new Error('must reuse wrapped key') },
    })
    assert.deepEqual(second, first)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses to create plaintext key material when safe storage is unavailable', () => {
  assert.throws(() => loadOrCreateDesktopContextKey({
    path: 'unused',
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    },
  }), /safe storage is unavailable/)
})
