import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decryptLinkSecrets, encryptLinkSecrets, loadOrCreateLinkSecrets } from '../src/link-secret-store.ts'

test('Link secrets are independently encrypted with the connection-vault master key', () => {
  const masterKey = randomBytes(32)
  const secrets = { encryptionKey: 'encryption', adminToken: 'admin', runtimeToken: 'runtime' }
  const encrypted = encryptLinkSecrets(secrets, masterKey)
  assert.deepEqual(decryptLinkSecrets(encrypted, masterKey), secrets)
  assert.equal(JSON.stringify(encrypted).includes('runtime'), false)
  assert.throws(() => decryptLinkSecrets(encrypted, randomBytes(32)))
})

test('Link secret record is durable and never stores plaintext tokens', () => {
  const root = mkdtempSync(join(tmpdir(), 'lume-link-secret-'))
  try {
    const path = join(root, 'secrets.json')
    const masterKey = randomBytes(32)
    const first = loadOrCreateLinkSecrets(path, masterKey)
    const second = loadOrCreateLinkSecrets(path, masterKey)
    assert.deepEqual(second, first)
    const stored = readFileSync(path, 'utf8')
    assert.equal(stored.includes(first.adminToken), false)
    assert.equal(stored.includes(first.runtimeToken), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
