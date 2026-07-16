import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogContentDigest, createSidecarLogDigestPolicy, isSafeStorageSecure } from '../src/logging/log-digest-policy.ts'

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`wrapped:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').slice('wrapped:'.length),
}

test('derives a stable producer key from an encrypted per-install root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lume-log-digest-'))
  const rootKeyPath = join(dir, 'digest-root.bin')
  try {
    const first = createSidecarLogDigestPolicy({
      rootKeyPath,
      safeStorage,
      allowPersistentKey: true,
      randomBytes: () => Buffer.alloc(32, 7),
    })
    const second = createSidecarLogDigestPolicy({
      rootKeyPath,
      safeStorage,
      allowPersistentKey: true,
      randomBytes: () => { throw new Error('must reuse wrapped root') },
    })
    assert.equal(first.scope, 'install')
    assert.equal(first.key, second.key)
    assert.equal(Buffer.from(first.key, 'base64').length, 32)
    assert.equal(createLogContentDigest(first, 'same content', 'agent-content:user'), createLogContentDigest(second, 'same content', 'agent-content:user'))
    assert.notEqual(createLogContentDigest(first, 'same content', 'agent-content:user'), createLogContentDigest(first, 'same content', 'agent-content:assistant'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('uses a session-scoped key when secure persistence is unavailable', () => {
  const policy = createSidecarLogDigestPolicy({
    rootKeyPath: 'unused',
    safeStorage: { ...safeStorage, isEncryptionAvailable: () => false },
    allowPersistentKey: false,
    randomBytes: () => Buffer.alloc(32, 3),
  })
  assert.equal(policy.scope, 'session')
  assert.equal(Buffer.from(policy.key, 'base64').length, 32)
})

test('accepts platforms without a storage-backend probe and rejects basic_text', () => {
  assert.equal(isSafeStorageSecure(safeStorage), true)
  assert.equal(isSafeStorageSecure({ ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }), false)
  assert.equal(isSafeStorageSecure({ ...safeStorage, isEncryptionAvailable: () => false }), false)
})
