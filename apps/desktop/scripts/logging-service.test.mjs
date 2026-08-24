import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoggingService, normalizeLogValue } from '../src/logging/logging-service.ts'

// Windows 上 service 构造函数后台的 mkdir/cleanup 链可能短暂持有目录句柄，rm 需要重试。
async function rmRetry(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

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
    body: 'raw provider body',
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
    await rmRetry(configDir)
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
    await rmRetry(configDir)
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
    await rmRetry(configDir)
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
    await rmRetry(configDir)
  }
})

// #122: append 失败时整批事件必须回队，恢复后在下次 flush 重试，而不是静默丢失。
test('flush failure keeps the batch queued and retries it (#122)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-flush-retry-'))
  // 同名文件占住 logs 路径，让 mkdir/appendFile 全部失败（ENOTDIR）。
  await Bun.write(join(configDir, 'logs'), 'not a directory')
  const service = new LoggingService({ configDir, terminal: { write: () => true } })
  const received = []
  service.subscribe((events) => { received.push(...events) })
  try {
    service.emit({ level: 'warn', source: 'main', context: 'test', event: 'test.append.fail', message: 'm' })
    await service.flush()
    assert.equal(received.length, 0)
    assert.equal(service.queue.length, 1)

    await rm(join(configDir, 'logs'), { force: true })
    await mkdir(join(configDir, 'logs'), { recursive: true })
    await service.flush()
    assert.equal(received.length, 1)
    assert.equal(received[0].event, 'test.append.fail')
    assert.equal(service.queue.length, 0)
  } finally {
    await service.close()
    await rmRetry(configDir)
  }
})

// #123: settings.consoleLevel=debug 必须对终端输出生效，不能只认环境变量。
test('settings.consoleLevel=debug surfaces debug events in the terminal (#123)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-console-debug-'))
  const terminal = []
  const service = new LoggingService({
    configDir,
    terminal: { write: (value) => { terminal.push(String(value)); return true } },
    settings: { consoleLevel: 'debug' },
  })
  try {
    service.emit({ level: 'debug', source: 'main', context: 'test', event: 'test.debug', message: 'm' })
    assert.match(terminal.join(''), /DEBUG/)
  } finally {
    await service.close()
    await rmRetry(configDir)
  }
})

test('default consoleLevel still hides debug events in the terminal', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-console-default-'))
  const terminal = []
  const service = new LoggingService({
    configDir,
    terminal: { write: (value) => { terminal.push(String(value)); return true } },
  })
  try {
    service.emit({ level: 'debug', source: 'main', context: 'test', event: 'test.debug2', message: 'm' })
    assert.doesNotMatch(terminal.join(''), /DEBUG/)
  } finally {
    await service.close()
    await rmRetry(configDir)
  }
})

// 内容键输出截断预览而非全遮蔽；凭据键维持 [redacted]。
test('content keys are previewed instead of redacted', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-preview-'))
  const service = new LoggingService({
    configDir,
    terminal: { write: () => true },
    settings: { fileLevel: 'info' },
  })
  try {
    const event = service.emit({
      level: 'info',
      source: 'main',
      context: 'test',
      event: 'preview.case',
      message: 'x',
      data: { prompt: 'z'.repeat(500), apiKey: 'sk-live' },
    })
    assert.equal(event.data.apiKey, '[redacted]')
    assert.ok(event.data.prompt.startsWith('z'.repeat(200)))
    assert.ok(event.data.prompt.endsWith('…(+300)'))
  } finally {
    await service.close()
    await rmRetry(configDir)
  }
})
