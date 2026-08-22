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

// Identity must use the OS birth time (StartTime), not a JS-uptime estimate:
// the registry probes the same value, so bootstrap delay cannot skew the
// comparison (#313). Probed asynchronously so a slow PowerShell start never
// delays the command spawn; until it lands the state simply has no identity,
// which the registry treats as alive.
let workerIdentity

function readProcessIdentity(pid, callback) {
  if (process.platform === 'linux') {
    try {
      const statLine = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
      const processNameEnd = statLine.lastIndexOf(')')
      const fieldsAfterName = statLine.slice(processNameEnd + 2).trim().split(/\s+/)
      callback(fieldsAfterName[19] ? 'linux:' + fieldsAfterName[19] : undefined)
    } catch {
      callback(undefined)
    }
    return
  }
  if (process.platform === 'win32') {
    try {
      cp.execFile('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([DateTimeOffset]((Get-Process -Id ' + pid + ' -ErrorAction Stop).StartTime.ToUniversalTime())).ToUnixTimeSeconds()'
      ], { encoding: 'utf8', windowsHide: true, timeout: 10000 }, (error, stdout) => {
        const ticks = error ? '' : String(stdout || '').trim()
        callback(ticks ? 'win32:' + ticks : undefined)
      })
    } catch {
      callback(undefined)
    }
    return
  }
  try {
    cp.execFile('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5000
    }, (error, stdout) => {
      const startedAt = error ? '' : String(stdout || '').trim().replace(/\s+/g, ' ')
      callback(startedAt ? process.platform + ':' + startedAt : undefined)
    })
  } catch {
    callback(undefined)
  }
}

function updateState(patch) {
  let current = {}
  try { current = JSON.parse(fs.readFileSync(spec.statePath, 'utf8')) } catch {}
  const next = Object.assign({}, current, patch, {
    version: 2,
    workerPid: process.pid,
    processToken: spec.processToken,
    workerIdentity,
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
readProcessIdentity(process.pid, (identity) => {
  workerIdentity = identity ? spec.processToken + ':' + identity : undefined
  try {
    if (!finished) updateState({})
  } catch {}
})
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

// #381:spec.timeoutMs 缺省(后台任务未显式传 timeout)时不设到时击杀;
// setTimeout(fn, undefined) 会立即触发,必须条件化。
const timeout = spec.timeoutMs
  ? setTimeout(() => {
    timedOut = true
    stopTree(child)
  }, spec.timeoutMs)
  : undefined

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
  if (timeout) clearTimeout(timeout)
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
