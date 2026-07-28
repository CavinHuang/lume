/**
 * Self-contained Node/Bun worker source used for durable shell jobs.
 *
 * Keeping the worker inline avoids a second packaged runtime entrypoint while
 * still allowing the command process to outlive the Sidecar that launched it.
 */
export const PROCESS_JOB_WORKER_SOURCE = String.raw`
const fs = require('node:fs')
const cp = require('node:child_process')

const specPath = process.argv[process.argv.length - 1]
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
try { fs.rmSync(specPath, { force: true }) } catch {}

function writeJsonAtomic(path, value) {
  const temporary = path + '.' + process.pid + '.' + Date.now() + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temporary, path)
}

function updateState(patch) {
  let current = {}
  try { current = JSON.parse(fs.readFileSync(spec.statePath, 'utf8')) } catch {}
  const next = Object.assign({}, current, patch, {
    version: 2,
    workerPid: process.pid,
    processToken: spec.processToken,
    updatedAt: Date.now()
  })
  writeJsonAtomic(spec.statePath, next)
  return next
}

let stdoutBytes = 0
let stderrBytes = 0
let outputBytes = 0
let timedOut = false
let outputLimitReached = false
let stopping = false
let finished = false
const startedAt = Date.now()
const stdoutStream = fs.createWriteStream(spec.stdoutFile, { flags: 'a' })
const stderrStream = fs.createWriteStream(spec.stderrFile, { flags: 'a' })
const outputStream = fs.createWriteStream(spec.outputFile, { flags: 'a' })

function stopTree(child) {
  if (!child || !child.pid || stopping) return
  stopping = true
  if (process.platform === 'win32') {
    const killer = cp.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.unref()
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') }
  catch { try { child.kill('SIGTERM') } catch {} }
}

updateState({ status: 'running', heartbeatAt: Date.now(), startedAt })
const child = cp.spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: process.env,
  detached: process.platform !== 'win32',
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
})

const heartbeat = setInterval(() => {
  updateState({ status: 'running', heartbeatAt: Date.now(), childPid: child.pid })
}, 2000)

const timeout = setTimeout(() => {
  timedOut = true
  stopTree(child)
}, spec.timeoutMs)

function capture(stream, chunk) {
  const bytes = Buffer.from(chunk)
  const remaining = Math.max(0, spec.maxOutputBytes - outputBytes)
  const accepted = remaining > 0 ? bytes.subarray(0, remaining) : Buffer.alloc(0)
  outputBytes += accepted.length
  if (stream === 'stdout') {
    stdoutBytes += accepted.length
    if (accepted.length) stdoutStream.write(accepted)
  } else {
    stderrBytes += accepted.length
    if (accepted.length) stderrStream.write(accepted)
  }
  if (accepted.length) outputStream.write(accepted)
  if (accepted.length !== bytes.length && !outputLimitReached) {
    outputLimitReached = true
    stopTree(child)
  }
}

child.stdout.on('data', (chunk) => capture('stdout', chunk))
child.stderr.on('data', (chunk) => capture('stderr', chunk))

function finish(code, spawnError) {
  if (finished) return
  finished = true
  clearInterval(heartbeat)
  clearTimeout(timeout)
  stdoutStream.end()
  stderrStream.end()
  outputStream.end()
  let terminationReason = 'completed'
  let outcome = 'succeeded'
  if (spawnError) {
    terminationReason = 'spawn_error'
    outcome = 'failed'
  } else if (timedOut) {
    terminationReason = 'timeout'
    outcome = 'timed_out'
  } else if (outputLimitReached) {
    terminationReason = 'output_limit'
    outcome = 'failed'
  } else if (stopping) {
    terminationReason = 'aborted'
    outcome = 'cancelled'
  } else if (code !== 0) {
    terminationReason = 'nonzero'
    outcome = 'failed'
  }
  const execution = {
    version: 2,
    outcome,
    exitCode: code,
    timedOut,
    outputLimitReached,
    durationMs: Date.now() - startedAt,
    command: spec.redactedCommand,
    shell: spec.shell,
    purpose: spec.purpose,
    terminationReason,
    stdoutRef: { kind: 'file', path: spec.stdoutFile, size: stdoutBytes, mimeType: 'text/plain' },
    stderrRef: { kind: 'file', path: spec.stderrFile, size: stderrBytes, mimeType: 'text/plain' },
    resultRef: { kind: 'file', path: spec.outputFile, size: outputBytes, mimeType: 'text/plain' }
  }
  const status = outcome === 'succeeded' ? 'completed' : outcome === 'cancelled' ? 'stopped' : 'failed'
  const result = { version: 2, status, execution, finishedAt: Date.now(), spawnError }
  writeJsonAtomic(spec.resultFile, result)
  updateState({
    status,
    heartbeatAt: Date.now(),
    resultFile: spec.resultFile,
    outputFile: spec.outputFile,
    stdoutFile: spec.stdoutFile,
    stderrFile: spec.stderrFile,
    metadata: { execution }
  })
}

child.once('close', (code) => finish(code, undefined))
child.once('error', (error) => finish(null, error && error.message ? error.message : String(error)))
process.once('SIGTERM', () => stopTree(child))
process.once('SIGINT', () => stopTree(child))
`
