import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiagnosticContentStore } from '../src/logging/diagnostic-content-store.ts'

const crypto = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0x5a)),
  decrypt: (value) => Buffer.from([...value].map((byte) => byte ^ 0x5a)).toString('utf8'),
}

test('encrypts scoped diagnostic content separately and decrypts it on demand', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-diagnostic-'))
  const store = new DiagnosticContentStore(configDir, crypto)
  const lease = {
    enabled: true,
    configVersion: 4,
    expiresAt: '2099-01-01T00:00:00.000Z',
    scope: { threadId: 'thread-1' },
  }
  try {
    const id = await store.capture({
      schemaVersion: 1,
      envelopeType: 'sensitive-diagnostic',
      captureType: 'user_message',
      emittedAt: '2026-07-16T00:00:00.000Z',
      leaseVersion: 4,
      threadId: 'thread-1',
      traceId: 'trace-1',
      messageId: 'message-1',
      content: 'sensitive message body',
    }, lease)

    const file = join(store.directory, `${id}.diag`)
    assert.doesNotMatch(await readFile(file, 'utf8'), /sensitive message body/)
    assert.equal((await store.decrypt(id)).content, 'sensitive message body')
    assert.equal((await readdir(store.directory)).length, 1)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('rejects unavailable, stale, and out-of-scope captures', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-diagnostic-reject-'))
  const envelope = {
    schemaVersion: 1,
    envelopeType: 'sensitive-diagnostic',
    captureType: 'assistant_message',
    emittedAt: new Date().toISOString(),
    leaseVersion: 2,
    threadId: 'thread-other',
    traceId: 'trace-1',
    messageId: 'message-1',
    content: 'body',
  }
  try {
    const unavailable = new DiagnosticContentStore(configDir, { ...crypto, isAvailable: () => false })
    await assert.rejects(() => unavailable.capture(envelope, {
      enabled: true,
      configVersion: 2,
      expiresAt: '2099-01-01T00:00:00.000Z',
      scope: null,
    }), /unavailable/)
    const store = new DiagnosticContentStore(configDir, crypto)
    await assert.rejects(() => store.capture(envelope, {
      enabled: true,
      configVersion: 2,
      expiresAt: '2099-01-01T00:00:00.000Z',
      scope: { threadId: 'thread-1' },
    }), /outside diagnostic scope/)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})
