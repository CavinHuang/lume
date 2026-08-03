import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoggingService, normalizeLogValue } from '../src/logging/logging-service.ts'

test('normalizes cyclic and sensitive data without invoking getters', () => {
  let getterCalled = false
  const input = { apiKey: 'secret', referenceGrantId: 'grant-capability', ok: true }
  Object.defineProperty(input, 'danger', {
    enumerable: true,
    get() {
      getterCalled = true
      return 'nope'
    },
  })
  input.self = input

  assert.deepEqual(normalizeLogValue(input), {
    apiKey: '[redacted]',
    referenceGrantId: '[redacted]',
    ok: true,
    danger: '[Accessor]',
    self: '[Circular]',
  })
  assert.equal(getterCalled, false)
  assert.deepEqual(normalizeLogValue({ body: 'raw provider body', contentPreview: 'safe preview' }), {
    body: '[redacted]',
    contentPreview: 'safe preview',
  })
})

test('writes v2 NDJSON, filters ordinary debug, and keeps trace events', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-'))
  const terminal = []
  const service = new LoggingService({
    configDir,
    terminal: { write: (value) => { terminal.push(String(value)); return true } },
    now: () => new Date('2026-07-16T08:00:00.000Z'),
  })
  try {
    service.emit({
      level: 'info',
      source: 'main',
      context: 'desktop.lifecycle',
      event: 'app.started',
      message: 'started',
      data: { authorization: 'Bearer secret' },
    })
    service.emit({
      level: 'debug',
      source: 'main',
      context: 'desktop.sidecar.rpc',
      event: 'rpc.completed',
      message: 'healthcheck completed',
    })
    service.emit({
      level: 'trace',
      kind: 'trace',
      source: 'main',
      context: 'agent.dispatch',
      event: 'message.accepted',
      message: 'accepted',
      traceId: 'trace_123',
    })
    await service.flush()

    const path = join(configDir, 'logs', 'lume-2026-07-16.ndjson')
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].schemaVersion, 2)
    assert.equal(lines[0].data.authorization, '[redacted]')
    assert.equal(lines[1].event, 'message.accepted')
    assert.match(terminal.join(''), /INFO desktop\.lifecycle app\.started/)
    assert.doesNotMatch(terminal.join(''), /\[desktop\].*\[sidecar\]/)
  } finally {
    await service.close()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('validates batch source and deduplicates event IDs', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-batch-'))
  const service = new LoggingService({ configDir, terminal: { write: () => true } })
  const event = {
    eventId: 'event_1',
    emittedAt: new Date().toISOString(),
    level: 'info',
    source: 'sidecar',
    context: 'sidecar.lifecycle',
    event: 'sidecar.ready',
    message: 'ready',
  }
  try {
    const batch = { schemaVersion: 2, batchId: 'batch_1', source: 'sidecar', events: [event, event] }
    assert.equal(service.ingestBatch(batch, 'sidecar'), 1)
    assert.throws(() => service.ingestBatch(batch, 'renderer'), /source or schema/)
  } finally {
    await service.close()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('reads v2, legacy NDJSON, pino, and plain log lines', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-reader-'))
  const service = new LoggingService({ configDir, terminal: { write: () => true } })
  try {
    await service.listFiles()
    const path = join(configDir, 'logs', 'legacy.log')
    await Bun.write(path, [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', level: 'warn', source: 'sidecar', context: 'legacy', message: 'old' }),
      JSON.stringify({ time: 1, level: 50, context: 'pino', msg: 'failed' }),
      'plain text',
    ].join('\n'))
    const result = await service.readFile({ fileName: 'legacy.log', maxLines: 10 })
    assert.deepEqual(result.lines.map((line) => line.level), ['warn', 'error', 'info'])
    assert.match(result.lines[0].text, /legacy old/)
  } finally {
    await service.close()
    await rm(configDir, { recursive: true, force: true })
  }
})

test('queries retained log segments as one bounded result', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-query-'))
  const service = new LoggingService({ configDir, terminal: { write: () => true } })
  try {
    await service.listFiles()
    await Bun.write(join(configDir, 'logs', 'older.log'), [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', source: 'sidecar', message: 'needle older' }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', level: 'info', source: 'sidecar', message: 'ignored' }),
    ].join('\n'))
    await Bun.write(join(configDir, 'logs', 'newer.log'), [
      JSON.stringify({ timestamp: '2026-01-02T00:00:00.000Z', level: 'warn', source: 'main', message: 'needle newer' }),
    ].join('\n'))

    const result = await service.query({ fileName: '*', query: 'needle', maxLines: 10 })
    assert.equal(result.fileName, '*')
    assert.equal(result.totalLines, 3)
    assert.equal(result.matchedLines, 2)
    assert.deepEqual(new Set(result.lines.map((line) => line.fileName)), new Set(['older.log', 'newer.log']))

    const bounded = await service.query({ fileName: '*', query: 'needle', maxLines: 1 })
    assert.equal(bounded.matchedLines, 2)
    assert.equal(bounded.lines.length, 1)
  } finally {
    await service.close()
    await rm(configDir, { recursive: true, force: true })
  }
})
