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

// dev 构建默认放开控制台到 trace；env 或持久化覆盖优先。
test('dev builds default console level to trace until overridden', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-devtrace-'))
  const terminal = { write: () => true }
  const dev = new LoggingService({ configDir, isDev: true, terminal, now: () => new Date() })
  const prod = new LoggingService({ configDir, terminal, now: () => new Date() })
  const custom = new LoggingService({ configDir, isDev: true, settings: { consoleLevel: 'warn' }, terminal, now: () => new Date() })
  try {
    assert.equal(dev.getSettings().consoleLevel, 'trace')
    assert.equal(prod.getSettings().consoleLevel, 'info')
    assert.equal(custom.getSettings().consoleLevel, 'warn')
  } finally {
    await dev.close()
    await prod.close()
    await custom.close()
    await rmRetry(configDir)
  }
})

// pretty 格式须在行尾携带 data/error 摘要——参数/结果可见性是埋点的核心价值（评审 H1）。
test('pretty terminal lines include a clipped data summary', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-pretty-'))
  const chunks = []
  const terminal = { write: (text) => { chunks.push(text); return true } }
  const service = new LoggingService({ configDir, terminal, now: () => new Date() })
  service.updateSettings({ consoleLevel: 'trace' })
  try {
    service.emit({
      level: 'debug', source: 'main', context: 'desktop.ipc', event: 'command.completed',
      message: 'ipc completed: demo', durationMs: 12,
      data: { command: 'demo', result: { ok: 1 } },
    })
    const line = chunks.join('')
    assert.ok(line.includes('command.completed'))
    assert.ok(line.includes('"durationMs":12'))
    assert.ok(line.includes('"result":{"ok":1}'))
  } finally {
    await service.close()
    await rmRetry(configDir)
  }
})

// settings-replace 的全量快照回填不得把 dev trace 静默打回 info（评审 H2）。
test('updateSettings keeps dev trace when incoming value equals the default', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-devhot-'))
  const terminal = { write: () => true }
  const service = new LoggingService({ configDir, isDev: true, terminal, now: () => new Date() })
  try {
    assert.equal(service.getSettings().consoleLevel, 'trace')
    service.updateSettings({ consoleLevel: 'info' })
    assert.equal(service.getSettings().consoleLevel, 'trace')
    service.updateSettings({ consoleLevel: 'warn' })
    assert.equal(service.getSettings().consoleLevel, 'warn')
  } finally {
    await service.close()
    await rmRetry(configDir)
  }
})

// dev-trace 的 env 优先级矩阵（评审 T3）：显式 env > legacy env > 持久化非默认值 > dev 默认。
test('dev trace env precedence matrix', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-envmatrix-'))
  const terminal = { write: () => true }
  const prevConsole = process.env.LUME_LOG_CONSOLE_LEVEL
  const prevLegacy = process.env.LUME_LOG_LEVEL
  try {
    // 显式 env 存在时，dev 不做默认提升（运行时由 env 阈值生效）。
    process.env.LUME_LOG_CONSOLE_LEVEL = 'debug'
    delete process.env.LUME_LOG_LEVEL
    let service = new LoggingService({ configDir, isDev: true, terminal, now: () => new Date() })
    assert.equal(service.getSettings().consoleLevel, 'info')
    await service.close()

    // legacy env 在构造器中晚于 dev 提升应用，会覆盖之。
    delete process.env.LUME_LOG_CONSOLE_LEVEL
    process.env.LUME_LOG_LEVEL = 'warn'
    service = new LoggingService({ configDir, isDev: true, terminal, now: () => new Date() })
    assert.equal(service.getSettings().consoleLevel, 'warn')
    assert.equal(service.getSettings().fileLevel, 'warn')
    await service.close()

    // legacy env + 持久化非默认值并存：legacy 仍胜出（既有语义，此处钉住）。
    process.env.LUME_LOG_LEVEL = 'warn'
    service = new LoggingService({ configDir, isDev: true, settings: { consoleLevel: 'debug' }, terminal, now: () => new Date() })
    assert.equal(service.getSettings().consoleLevel, 'warn')
    await service.close()
  } finally {
    if (prevConsole === undefined) delete process.env.LUME_LOG_CONSOLE_LEVEL
    else process.env.LUME_LOG_CONSOLE_LEVEL = prevConsole
    if (prevLegacy === undefined) delete process.env.LUME_LOG_LEVEL
    else process.env.LUME_LOG_LEVEL = prevLegacy
    await rmRetry(configDir)
  }
})

// #752: exportAll 分段流式写出——导出文本格式保持「header\n内容\n\n」分节不变。
test('exportAll produces sectioned text export in reverse-chronological order', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-export-'))
  const service = new LoggingService({ configDir, terminal: { write: () => true } })
  try {
    await service.listFiles()
    await Bun.write(join(configDir, 'logs', 'older.log'), 'alpha-line')
    await Bun.write(join(configDir, 'logs', 'newer.log'), 'beta-line')
    const result = await service.exportAll()
    assert.ok(result.sizeBytes > 0)
    assert.match(result.fileName, /^lume-logs-.*\.txt$/)
    const exported = await readFile(join(configDir, 'logs', 'exports', result.fileName), 'utf8')
    assert.equal(
      exported,
      '===== newer.log =====\nbeta-line\n\n===== older.log =====\nalpha-line\n',
    )
  } finally {
    await service.close()
    await rmRetry(configDir)
  }
})

// #752: snapshotActive 单布尔收敛为计数——并发的 export/clear 必须都结束后才恢复 flush，
// 不能先结束的一个把暂停语义提前解除（否则 clear 未完时事件已写盘、导出内容撕裂）。
test('flush stays paused until every concurrent snapshot op completes (#752)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-snapshot-'))
  const service = new LoggingService({ configDir, terminal: { write: () => true }, now: () => new Date() })
  try {
    await service.listFiles()
    await Bun.write(join(configDir, 'logs', 'lume-2026-07-16.ndjson'), '{"v":1}\n')

    let gateResolve
    const gate = new Promise((resolve) => { gateResolve = resolve })
    const origListFiles = service.listFiles.bind(service)
    let listCalls = 0
    service.listFiles = async () => {
      listCalls += 1
      if (listCalls === 1) await gate
      return origListFiles()
    }

    const exporting = service.exportAll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const clearing = service.clear()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // clear 已完成而 export 仍卡在游标读取：此刻入队的事件必须仍处暂停语义之下。
    service.emit({ level: 'info', source: 'main', context: 'probe', event: 'app.started', message: 'during-export' })
    await service.flush()
    assert.equal(service.queue.length, 1, '并发快照未全部结束前 flush 必须保持暂停')

    gateResolve()
    await Promise.all([exporting, clearing])
    await service.flush()
    assert.equal(service.queue.length, 0, '全部快照结束后队列必须恢复冲刷')
  } finally {
    await service.close()
    await rmRetry(configDir)
  }
})

// #755: dev trace 洪水下，各源 info（含终端里程碑）不得被无保护驱逐。
// 构造要点：info 必须排在前 100 条之后（躲过同步洪水触发 flush#1 的首批 splice），
// 随后洪水把队列顶过 5000 上限，才会走到 enqueue 的驱逐路径。
test('queue saturation protects info events from trace floods (#755)', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-infoprotect-'))
  const service = new LoggingService({
    configDir,
    terminal: { write: () => true },
    now: () => new Date('2026-08-26T00:00:00.000Z'),
    settings: { fileLevel: 'trace' },
  })
  try {
    for (let i = 0; i < 200; i++) {
      service.emit({ level: 'trace', source: 'main', context: 'agent.dispatch', event: 'provider.stream.delta', message: `warm-${i}` })
    }
    service.emit({ level: 'info', source: 'main', context: 'desktop.lifecycle', event: 'app.started', message: 'milestone' })
    service.emit({ level: 'info', source: 'sidecar', context: 'sidecar.lifecycle', event: 'sidecar.ready', message: 'ready' })
    service.emit({ level: 'info', source: 'main', context: 'agent.dispatch', event: 'log.message', message: 'ordinary-info' })
    for (let i = 0; i < 5_200; i++) {
      service.emit({ level: 'trace', source: 'main', context: 'agent.dispatch', event: 'provider.stream.delta', message: `noise-${i}` })
    }
    const drained = []
    service.subscribe((events) => { drained.push(...events) })
    await service.close()
    const drainedEvents = drained.map((e) => `${e.level}:${e.event}`)
    assert.ok(drainedEvents.includes('info:app.started'), '终端里程碑 info 不得被驱逐')
    assert.ok(drainedEvents.includes('info:sidecar.ready'), 'sidecar.ready 不得被驱逐')
    assert.ok(drainedEvents.includes('info:log.message'), '普通 info 不得被 dev trace 洪水驱逐 (#755)')
  } finally {
    await rmRetry(configDir)
  }
})

// 三轮评审 F1：close() 首遍 flush 的 await 期间入队的事件须被尾窗补偿冲刷。
test('close drains events enqueued during the final flush', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'lume-logging-closedrain-'))
  const service = new LoggingService({ configDir, terminal: { write: () => true }, now: () => new Date() })
  try {
    service.emit({ level: 'info', source: 'main', context: 'probe', event: 'app.started', message: 'A-first' })
    const closing = service.close()
    // close 内部 flushInternal 挂起于 await mkdir/appendFile 时同步入队 B
    service.emit({ level: 'info', source: 'main', context: 'probe', event: 'app.started', message: 'B-during-flush' })
    await closing
    const files = await (async () => {
      const { readdir } = await import('node:fs/promises')
      return readdir(join(configDir, 'logs'))
    })()
    const content = files
      .filter((f) => f.endsWith('.ndjson'))
      .map((f) => require('node:fs').readFileSync(join(configDir, 'logs', f), 'utf8'))
      .join('')
    assert.ok(content.includes('A-first'))
    assert.ok(content.includes('B-during-flush'), '尾窗事件必须落盘')
  } finally {
    await rmRetry(configDir)
  }
})
