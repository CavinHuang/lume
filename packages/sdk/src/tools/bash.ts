/** Execute shell commands with one lifecycle for foreground and background work. */

import { appendFile, mkdir, open, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  createProcessJobRecord,
  discardProcessJob,
  getProcessJob,
  markProcessJobNotified,
  processJobsRootForArtifacts,
  registerProcessStopHandler,
  removeProcessJob,
  stopPersistedWorker,
  unregisterProcessStopHandler,
  updateProcessJob,
} from './process-job-registry.js'
import { PROCESS_JOB_WORKER_SOURCE } from './process-job-worker.js'
import { defineTool } from './types.js'
import type { ToolContext, ToolExecutionMetadata, ToolResult } from '../types.js'
import { bundledRipgrepDirectory } from '../utils/ripgrep.js'
import { analyzeBashCommand } from '../utils/bash-command-analysis.js'
import { resolveShellInvocation, shellKind } from '../utils/shell-invocation.js'
import { isReadOnlyShellInput } from '../utils/shell-read-only.js'
import { spawnWithProcessSandbox, terminateProcessTree } from '../utils/process-sandbox.js'

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024
const MAX_RESULT_CHARS = 100_000
const PREVIEW_CHARS = 4_000
// Result previews keep the tail within both bounds (errors live at the end).
// Per-stream char budget sits under half the final result budget by enough
// margin that two full sections plus their labels/footers still fit the
// assembler's structural budget — the assembly-level trim then only fires as a
// pathological backstop (where it appends its own truncation footer).
const RESULT_MAX_LINES = 500
const RESULT_SECTION_MAX_CHARS = 49_500
// Live streaming snapshots ride the live channel while the command runs.
const STREAM_SNAPSHOT_THROTTLE_MS = 150
const STREAM_SNAPSHOT_MAX_CHARS = 16_000
const AUTO_BACKGROUND_MS = 15_000
const PROGRESS_THRESHOLD_MS = 2_000
const STALL_CHECK_INTERVAL_MS = 5_000
const STALL_THRESHOLD_MS = 45_000

const INTERACTIVE_PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
]

export function looksLikeInteractivePrompt(output: string): boolean {
  const lastLine = output.trimEnd().split(/\r?\n/).pop() ?? ''
  return INTERACTIVE_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine))
}

type ShellTask = Awaited<ReturnType<typeof startShellTask>>

export const BashTool = defineTool({
  name: 'Bash',
  description: 'Execute a shell command and return its output. Commands still running after the foreground budget continue in the background and emit one terminal notification; do not poll ProcessOutput. Read the returned output file when full logs are needed. On Windows, use a configured POSIX bash when available; otherwise commands run through PowerShell. Keep each command in one shell dialect and do not mix cmd.exe, PowerShell, and POSIX syntax.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute. Use one shell dialect per command; on Windows without configured POSIX Bash, prefer PowerShell syntax and do not use cmd.exe or POSIX-only redirection.' },
      timeout: { type: 'number', description: 'Optional timeout in milliseconds (max 600000). When omitted the command runs without a process timeout.' },
      description: { type: 'string', description: 'Short description for background task tracking' },
      run_in_background: { type: 'boolean', description: 'Run the command in the background and return a task ID immediately' },
      purpose: { type: 'string', description: 'Optional execution purpose, e.g. verification' },
    },
    required: ['command'],
  },
  isReadOnly: (input: unknown, context?: ToolContext) => isReadOnlyShellInput(input, context),
  isConcurrencySafe: (input: unknown, context?: ToolContext) => isReadOnlyShellInput(input, context),
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.command !== 'string' || !input.command.trim()) return 'command is required.'
    if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0)) return 'timeout must be a positive number.'
    if (input.run_in_background !== undefined && typeof input.run_in_background !== 'boolean') return 'run_in_background must be a boolean.'
  },
  async call(input, context) {
    const command = String(input.command)
    // #381:未显式传 timeout 不设进程超时——前台等待只有 15s 即转后台,默认
    // 120s 的唯一生效点是击杀后台长任务(dev server/watcher),与"continue in
    // the background"语义矛盾;显式 timeout 仍尊重(上限 600s)。
    const timeoutMs = input.timeout === undefined
      ? undefined
      : Math.min(Number(input.timeout), 600_000)
    const purpose = typeof input.purpose === 'string' && input.purpose.trim() ? input.purpose.trim() : undefined
    const verificationError = purpose?.toLowerCase() === 'verification'
      ? getVerificationPipelineError(command)
      : undefined
    if (verificationError) {
      return {
        data: verificationError,
        is_error: true,
        _meta: {
          error: { code: 'verification_pipeline_not_allowed', command },
          execution: {
            version: 2,
            outcome: 'failed',
            exitCode: null,
            durationMs: 0,
            command: redactSensitiveText(command),
            shell: shellKind(resolveShellInvocation(command).command),
            purpose,
            terminationReason: 'spawn_error',
          },
        },
      }
    }
    const excluded = context.sandbox?.excludedCommands ?? []
    if (excluded.length > 0) {
      const blocked = checkExcludedCommands(command, excluded)
      if (blocked === 'complex') {
        return {
          data: `Sandbox refused compound command: excluded commands (${excluded.join(", ")}) cannot be verified inside $(), subshells, or multi-statement syntax. Run it as simple commands.`,
          is_error: true,
        }
      }
      if (blocked) return { data: `Sandbox blocked command prefix "${blocked}"`, is_error: true }
    }
    const shell = resolveShellInvocation(command)
    const dialectError = getShellDialectError(command, shell.command)
    if (dialectError) {
      return {
        data: dialectError,
        is_error: true,
        _meta: { error: { code: 'mixed_shell_dialect', shell: shellKind(shell.command), command } },
      }
    }

    const task = await startShellTask({ command, timeoutMs, purpose, context })
    if (input.run_in_background) return promoteToBackground(task, input.description, context)

    const initial = await Promise.race([
      task.done,
      delay(PROGRESS_THRESHOLD_MS).then(() => null),
    ])
    if (initial) return finishForegroundTask(task, initial)

    context.emitEvent?.({
      type: 'system',
      subtype: 'local_command_output',
      content: 'Command is still running.',
      session_id: context.sessionId || '',
    })

    const completion = await Promise.race([
      task.done,
      delay(Math.max(0, AUTO_BACKGROUND_MS - PROGRESS_THRESHOLD_MS)).then(() => null),
    ])
    if (completion) return finishForegroundTask(task, completion)
    return promoteToBackground(task, input.description, context, true)
  },
})

async function startShellTask(input: {
  command: string
  timeoutMs?: number
  purpose?: string
  context: ToolContext
}) {
  if (input.context.artifactsRoot && input.context.sessionId) {
    return startDurableShellTask(input)
  }
  return startDirectShellTask(input)
}

async function startDirectShellTask({
  command,
  timeoutMs,
  purpose,
  context,
}: {
  command: string
  timeoutMs?: number
  purpose?: string
  context: ToolContext
}) {
  const outputDirectory = context.artifactsRoot ? join(context.artifactsRoot, 'tool-results') : tmpdir()
  await mkdir(outputDirectory, { recursive: true })
  const outputFile = join(outputDirectory, `bash-${context.sessionId || 'session'}-${Date.now()}-${crypto.randomUUID()}.log`)
  await writeFile(outputFile, '', 'utf8')

  const shell = resolveShellInvocation(command)
  const shellType = shellKind(shell.command)
  const sandbox = withBundledRipgrepSandbox(context.sandbox)
  const detached = process.platform !== 'win32'
  const proc = spawnWithProcessSandbox(shell.command, shell.args, {
    cwd: context.cwd,
    env: { ...process.env },
    timeoutMs,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  }, sandbox)
  const startedAt = Date.now()
  let outputBytes = 0
  const stdoutAccumulator = createPreviewAccumulator(RESULT_MAX_LINES, RESULT_SECTION_MAX_CHARS)
  const stderrAccumulator = createPreviewAccumulator(RESULT_MAX_LINES, RESULT_SECTION_MAX_CHARS)
  const emitStreamSnapshot = createStreamSnapshotEmitter(context, () => combinedStreamSnapshot(stdoutAccumulator, stderrAccumulator))
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let terminationReason: ToolExecutionMetadata['terminationReason'] = 'completed'
  let settled = false
  let writeChain = Promise.resolve()
  let attachedTaskId: string | undefined
  let progressTimer: ReturnType<typeof setInterval> | undefined
  let stallTimer: ReturnType<typeof setInterval> | undefined
  let completedResult: ShellTaskResult | undefined
  let backgroundCompletionHandled = false
  let lastOutputAt = startedAt

  const completeBackgroundTask = (result: ShellTaskResult) => {
    if (!attachedTaskId || backgroundCompletionHandled) return
    backgroundCompletionHandled = true
    if (stallTimer) clearInterval(stallTimer)
    const status = result.execution.terminationReason === 'completed' ? 'completed'
      : result.execution.terminationReason === 'aborted' ? 'stopped' : 'failed'
    updateProcessJob(attachedTaskId, { status, output: boundedPreview(result.output, MAX_RESULT_CHARS), metadata: { execution: result.execution } })
    unregisterProcessStopHandler(attachedTaskId)
    if (markProcessJobNotified(attachedTaskId)) {
      context.emitEvent?.({
        type: 'system', subtype: 'task_notification', task_id: attachedTaskId,
        ...(context.toolUseId ? { tool_use_id: context.toolUseId } : {}),
        status, output_file: outputFile,
        summary: status === 'completed'
          ? `Background command completed. Full output: ${outputFile}`
          : `Background command ${status} (${result.execution.terminationReason}). Full output: ${outputFile}`,
        message: boundedPreview(result.output),
        execution: result.execution, session_id: context.sessionId || '',
      })
    }
    context.onBackgroundTaskCompleted?.()
  }

  const appendOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (settled) return
    const remaining = MAX_OUTPUT_BYTES - outputBytes
    const accepted = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0)
    outputBytes += accepted.length
    if (accepted.length > 0) {
      lastOutputAt = Date.now()
      const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(accepted)
      ;(stream === 'stdout' ? stdoutAccumulator : stderrAccumulator).append(text)
      writeChain = writeChain.then(() => appendFile(outputFile, accepted))
      emitStreamSnapshot.schedule()
    }
    if (accepted.length !== chunk.length && terminationReason === 'completed') {
      terminationReason = 'output_limit'
      terminateProcessTree(proc, { detached: true })
    }
  }

  const stop = (reason: ToolExecutionMetadata['terminationReason'] = 'aborted') => {
    if (settled) return
    if (terminationReason === 'completed') terminationReason = reason
    terminateProcessTree(proc, { detached: true })
  }
  const timeoutTimer = timeoutMs !== undefined ? setTimeout(() => stop('timeout'), timeoutMs) : undefined
  timeoutTimer?.unref?.()
  const abortHandler = () => stop('aborted')
  context.abortSignal?.addEventListener('abort', abortHandler, { once: true })
  proc.stdout?.on('data', (chunk: Buffer) => appendOutput('stdout', chunk))
  proc.stderr?.on('data', (chunk: Buffer) => appendOutput('stderr', chunk))

  const done = new Promise<ShellTaskResult>((resolve) => {
    const finish = async (code: number | null, spawnError?: string) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      context.abortSignal?.removeEventListener('abort', abortHandler)
      if (progressTimer) clearInterval(progressTimer)
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      if (stdoutTail) stdoutAccumulator.append(stdoutTail)
      if (stderrTail) stderrAccumulator.append(stderrTail)
      if (spawnError) stderrAccumulator.append(spawnError)
      // Flush after the decoder tails land so the last snapshot is complete.
      emitStreamSnapshot.flush()
      await writeChain.catch(() => undefined)
      const interpretation = interpretShellExit(command, code ?? 1)
      if (terminationReason === 'completed' && code !== 0 && interpretation.isError) terminationReason = 'nonzero'
      if (spawnError) terminationReason = 'spawn_error'
      const stdoutStats = stdoutAccumulator.snapshot()
      const stderrStats = stderrAccumulator.snapshot()
      const stdoutPreview = stdoutStats.content
      const stderrPreview = stderrStats.content
      const execution = await createExecutionMetadata({
        command,
        shell: shellType,
        ...(interpretation.semanticOutcome ? { semanticOutcome: interpretation.semanticOutcome } : {}),
        purpose,
        outputFile,
        outputBytes,
        stdoutPreview,
        stderrPreview,
        code,
        startedAt,
        terminationReason,
      })
      const firstLine = terminationReason === 'completed'
        ? (interpretation.semanticOutcome === 'no_matches'
          ? 'Command completed: no matches found (exit code 1).'
          : `Command completed successfully (exit code ${code ?? 0}${stdoutPreview || stderrPreview ? '' : ', no output'}).`)
        : `Command terminated (${terminationReason}${code !== null ? `, exit code ${code}` : ''}).`
      const footer = truncationFooter(stdoutStats, stderrStats, outputFile)
      const output = assembleShellResult(
        firstLine,
        [
          stdoutPreview ? `stdout:\n${stdoutPreview}` : '',
          stderrPreview ? `stderr:\n${stderrPreview}` : '',
          spawnError ? `process error: ${spawnError}` : '',
          ...(footer ? [footer] : []),
        ],
        code !== 0 && code !== null
          ? `Bash failed (${shellType}, exit code ${code}): ${interpretation.message}`
          : undefined,
        { outputFile, footer },
      )
      const result = { output, isError: terminationReason !== 'completed' || interpretation.isError, execution }
      completedResult = result
      completeBackgroundTask(result)
      resolve(result)
    }
    proc.once('close', (code) => { void finish(code) })
    proc.once('error', (error) => { void finish(null, error.message) })
  })

  return {
    command,
    outputFile,
    job: undefined,
    done,
    promote(taskId: string, subject: string): ShellTaskResult | undefined {
      if (attachedTaskId) return undefined
      if (completedResult) return completedResult
      attachedTaskId = taskId
      registerProcessStopHandler(taskId, () => stop('aborted'))
      progressTimer = setInterval(() => {
        // Prefer the live channel: progress is only meaningful while the
        // command is still running, and buffering it until the tool batch
        // completes would defeat the heartbeat. Fall back to the deferred
        // channel when the host has no live receiver.
        ;(context.emitLiveEvent ?? context.emitEvent)?.({
          type: 'system', subtype: 'task_progress', task_id: taskId, description: subject,
          last_tool_name: 'Bash', usage: { total_tokens: 0, tool_uses: 1, duration_ms: Date.now() - startedAt },
          session_id: context.sessionId || '',
        })
      }, 1_000)
      progressTimer.unref?.()
      let stallNotified = false
      stallTimer = setInterval(() => {
        if (stallNotified || Date.now() - lastOutputAt < STALL_THRESHOLD_MS) return
        const tail = `${stdoutAccumulator.snapshot().content}\n${stderrAccumulator.snapshot().content}`.trimEnd()
        if (!looksLikeInteractivePrompt(tail)) {
          lastOutputAt = Date.now()
          return
        }
        stallNotified = true
        if (stallTimer) clearInterval(stallTimer)
        context.emitEvent?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          ...(context.toolUseId ? { tool_use_id: context.toolUseId } : {}),
          status: 'attention',
          output_file: outputFile,
          summary: `Background command "${subject}" appears to be waiting for interactive input`,
          message: [
            tail ? `Last output:\n${boundedPreview(tail, 1_024)}` : '',
            'The command may be blocked on an interactive prompt. Stop it and rerun with piped input or a non-interactive flag.',
          ].filter(Boolean).join('\n\n'),
          session_id: context.sessionId || '',
        })
      }, STALL_CHECK_INTERVAL_MS)
      stallTimer.unref?.()
      proc.unref()
      return undefined
    },
  }
}

async function startDurableShellTask({
  command,
  timeoutMs,
  purpose,
  context,
}: {
  command: string
  timeoutMs?: number
  purpose?: string
  context: ToolContext
}) {
  const jobsRoot = processJobsRootForArtifacts(context.artifactsRoot)!
  await mkdir(jobsRoot, { recursive: true })
  const shell = resolveShellInvocation(command)
  const shellType = shellKind(shell.command)
  const processToken = crypto.randomUUID()
  const job = createProcessJobRecord({
    subject: 'Shell command',
    description: redactSensitiveText(command),
    status: 'running',
    threadId: context.sessionId,
    runId: context.runId,
    toolUseId: context.toolUseId,
    taskType: 'shell',
    processToken,
    metadata: {
      execution: runningExecution(command, '', shellType),
    },
  })
  const jobDir = join(jobsRoot, job.id)
  const outputFile = join(jobDir, 'output.log')
  const stdoutFile = join(jobDir, 'stdout.log')
  const stderrFile = join(jobDir, 'stderr.log')
  const resultFile = join(jobDir, 'result.json')
  const specPath = join(jobDir, 'launch.json')
  await mkdir(jobDir, { recursive: true })
  await Promise.all([
    writeFile(outputFile, ''),
    writeFile(stdoutFile, ''),
    writeFile(stderrFile, ''),
  ])
  updateProcessJob(job.id, {
    jobDir,
    outputFile,
    stdoutFile,
    stderrFile,
    resultFile,
    metadata: {
      execution: runningExecution(command, outputFile, shellType),
    },
  })
  await writeFile(specPath, JSON.stringify({
    command: shell.command,
    args: shell.args,
    cwd: context.cwd,
    // #381:undefined 时省略字段——worker setTimeout(fn, undefined) 会立即击杀
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    maxOutputBytes: MAX_OUTPUT_BYTES,
    processToken,
    statePath: join(jobDir, 'state.json'),
    resultFile,
    outputFile,
    stdoutFile,
    stderrFile,
    redactedCommand: redactSensitiveText(command),
    shell: shellType,
    purpose,
  }), 'utf8')

  const sandbox = withBundledRipgrepSandbox(context.sandbox)
  const worker = spawnWithProcessSandbox(process.execPath, ['-e', PROCESS_JOB_WORKER_SOURCE, specPath], {
    cwd: context.cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // #381:worker 比命令超时多 10s 兜底;命令无超时则 worker 同样无界
    ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs + 10_000 } : {}),
    detached: true,
    stdio: 'ignore',
  }, sandbox)
  updateProcessJob(job.id, {
    workerPid: worker.pid,
    heartbeatAt: Date.now(),
  })
  worker.unref()

  let attachedTaskId: string | undefined
  let completedResult: ShellTaskResult | undefined
  let outputOffset = 0
  let stdoutOffset = 0
  let stderrOffset = 0
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  const stdoutAccumulator = createPreviewAccumulator(RESULT_MAX_LINES, RESULT_SECTION_MAX_CHARS)
  const stderrAccumulator = createPreviewAccumulator(RESULT_MAX_LINES, RESULT_SECTION_MAX_CHARS)
  const emitStreamSnapshot = createStreamSnapshotEmitter(context, () => combinedStreamSnapshot(stdoutAccumulator, stderrAccumulator))
  let progressTimer: ReturnType<typeof setInterval> | undefined
  let stallTimer: ReturnType<typeof setInterval> | undefined
  let lastOutputAt = Date.now()
  let settled = false
  let backgroundCompletionHandled = false
  const startedAt = Date.now()

  // Async spawn failures (e.g. EMFILE) surface as an 'error' event; without a
  // listener they become an uncaughtException and take down the host process.
  worker.once('error', () => {
    if (getProcessJob(job.id)?.status !== 'running') return
    const execution = normalizePersistedExecution(command, purpose, shellType, outputFile, {
      version: 2,
      outcome: 'failed',
      terminationReason: 'spawn_error',
      exitCode: null,
      durationMs: Date.now() - startedAt,
      command: redactSensitiveText(command),
      shell: shellType,
    }, startedAt)
    updateProcessJob(job.id, { status: 'failed', metadata: { execution } })
  })

  const emitNewOutput = async (): Promise<boolean> => {
    const before = stdoutOffset + stderrOffset + outputOffset
    const stdout = await readIncrementalFile(stdoutFile, stdoutOffset)
    stdoutOffset = stdout.nextOffset
    if (stdout.chunk.length > 0) {
      lastOutputAt = Date.now()
      // Streamed decode keeps multibyte sequences that straddle block
      // boundaries intact (#368).
      const text = stdoutDecoder.write(stdout.chunk)
      stdoutAccumulator.append(text)
      emitStreamSnapshot.schedule()
    }
    const stderr = await readIncrementalFile(stderrFile, stderrOffset)
    stderrOffset = stderr.nextOffset
    if (stderr.chunk.length > 0) {
      lastOutputAt = Date.now()
      const text = stderrDecoder.write(stderr.chunk)
      stderrAccumulator.append(text)
      emitStreamSnapshot.schedule()
    }
    const combined = await readIncrementalFile(outputFile, outputOffset)
    outputOffset = combined.nextOffset
    return stdoutOffset + stderrOffset + outputOffset !== before
  }

  const completeBackgroundTask = (result: ShellTaskResult) => {
    if (!attachedTaskId || backgroundCompletionHandled) return
    backgroundCompletionHandled = true
    if (progressTimer) clearInterval(progressTimer)
    if (stallTimer) clearInterval(stallTimer)
    const status = executionOutcome(result.execution) === 'succeeded'
      ? 'completed'
      : executionOutcome(result.execution) === 'cancelled' ? 'stopped' : 'failed'
    updateProcessJob(attachedTaskId, {
      status,
      output: boundedPreview(result.output, MAX_RESULT_CHARS),
      metadata: { execution: result.execution },
    })
    unregisterProcessStopHandler(attachedTaskId)
    if (markProcessJobNotified(attachedTaskId)) {
      context.emitEvent?.({
        type: 'system',
        subtype: 'task_notification',
        task_id: attachedTaskId,
        ...(context.toolUseId ? { tool_use_id: context.toolUseId } : {}),
        status,
        output_file: outputFile,
        summary: status === 'completed'
          ? `Background command completed. Full output: ${outputFile}`
          : `Background command ${status} (${result.execution.terminationReason}). Full output: ${outputFile}`,
        message: boundedPreview(result.output),
        execution: result.execution,
        session_id: context.sessionId || '',
      })
    }
    context.onBackgroundTaskCompleted?.()
  }

  const done = new Promise<ShellTaskResult>((resolveDone) => {
    const poll = setInterval(() => {
      void (async () => {
        await emitNewOutput()
        const latest = getProcessJob(job.id)
        if (!latest || latest.status === 'running') return
        clearInterval(poll)
        if (settled) return
        settled = true
        // Drain the worker's final writes to EOF; a single bounded read can
        // lose tail output written just before the process exited.
        while (await emitNewOutput()) { /* drain until no new bytes */ }
        const stdoutTail = stdoutDecoder.end()
        const stderrTail = stderrDecoder.end()
        if (stdoutTail) stdoutAccumulator.append(stdoutTail)
        if (stderrTail) stderrAccumulator.append(stderrTail)
        // Flush after the decoder tails land so the last snapshot is complete.
        emitStreamSnapshot.flush()
        const execution = normalizePersistedExecution(
          command,
          purpose,
          shellType,
          outputFile,
          latest.metadata?.execution,
          startedAt,
        )
        const interpretation = interpretShellExit(command, execution.exitCode ?? 1)
        const normalizedExecution = applySemanticOutcome(execution, interpretation)
        const stdoutStats = stdoutAccumulator.snapshot()
        const stderrStats = stderrAccumulator.snapshot()
        const output = formatShellResult(normalizedExecution, stdoutStats.content, stderrStats.content, interpretation, truncationFooter(stdoutStats, stderrStats, outputFile), outputFile)
        const result = {
          output,
          isError: executionOutcome(normalizedExecution) !== 'succeeded',
          execution: normalizedExecution,
        }
        completedResult = result
        completeBackgroundTask(result)
        resolveDone(result)
      })()
    }, 100)
    poll.unref?.()
  })

  const stop = () => {
    const latest = getProcessJob(job.id)
    if (!latest || latest.status !== 'running') return
    // A direct signal would only reach the worker (on Windows TerminateProcess
    // kills exactly one process); the registry helper tears down the whole
    // command process tree.
    stopPersistedWorker(latest)
    const execution = normalizePersistedExecution(command, purpose, shellType, outputFile, {
      version: 2,
      outcome: 'cancelled',
      terminationReason: 'aborted',
      exitCode: null,
      durationMs: Date.now() - startedAt,
      command: redactSensitiveText(command),
      shell: shellType,
    }, startedAt)
    updateProcessJob(job.id, { status: 'stopped', metadata: { execution } })
  }
  context.abortSignal?.addEventListener('abort', stop, { once: true })

  return {
    command,
    outputFile,
    job,
    done,
    promote(taskId: string, subject: string): ShellTaskResult | undefined {
      if (attachedTaskId) return undefined
      if (completedResult) return completedResult
      attachedTaskId = taskId
      updateProcessJob(taskId, { subject, description: redactSensitiveText(command) })
      registerProcessStopHandler(taskId, stop)
      progressTimer = setInterval(() => {
        // Live channel preferred — see the promote() heartbeat above.
        ;(context.emitLiveEvent ?? context.emitEvent)?.({
          type: 'system',
          subtype: 'task_progress',
          task_id: taskId,
          description: subject,
          last_tool_name: 'Bash',
          usage: { total_tokens: 0, tool_uses: 1, duration_ms: Date.now() - startedAt },
          session_id: context.sessionId || '',
        })
      }, 1_000)
      progressTimer.unref?.()
      let stallNotified = false
      stallTimer = setInterval(() => {
        if (stallNotified || Date.now() - lastOutputAt < STALL_THRESHOLD_MS) return
        const tail = `${stdoutAccumulator.snapshot().content}\n${stderrAccumulator.snapshot().content}`.trimEnd()
        if (!looksLikeInteractivePrompt(tail)) return
        stallNotified = true
        context.emitEvent?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          ...(context.toolUseId ? { tool_use_id: context.toolUseId } : {}),
          status: 'attention',
          output_file: outputFile,
          summary: `Background command "${subject}" appears to be waiting for interactive input`,
          message: [
            tail ? `Last output:\n${boundedPreview(tail, 1_024)}` : '',
            'The command may be blocked on an interactive prompt. Stop it and rerun with piped input or a non-interactive flag.',
          ].filter(Boolean).join('\n\n'),
          session_id: context.sessionId || '',
        })
      }, STALL_CHECK_INTERVAL_MS)
      stallTimer.unref?.()
      return undefined
    },
  }
}

async function promoteToBackground(task: ShellTask, description: unknown, context: ToolContext, automatic = false): Promise<ToolResult> {
  const subject = typeof description === 'string' && description.trim() ? description.trim() : 'Background shell command'
  const job = task.job ?? createProcessJobRecord({
      subject,
      // Redact at creation so a crash between record creation and the
      // follow-up update cannot leave plaintext credentials in state.json.
      description: redactSensitiveText(task.command),
      status: 'running',
      threadId: context.sessionId,
      runId: context.runId,
      toolUseId: context.toolUseId,
      outputFile: task.outputFile,
      taskType: 'shell',
      metadata: { execution: runningExecution(task.command, task.outputFile, shellKind(resolveShellInvocation(task.command).command)) },
    })
  updateProcessJob(job.id, { subject, description: redactSensitiveText(task.command) })
  const completedDuringPromotion = task.promote(job.id, subject)
  if (completedDuringPromotion) {
    if (job.jobDir) discardProcessJob(job.id)
    else removeProcessJob(job.id)
    return toToolResult(completedDuringPromotion)
  }
  context.emitEvent?.({
    type: 'system', subtype: 'task_started', task_id: job.id, description: subject, task_type: 'shell',
    ...(context.toolUseId ? { tool_use_id: context.toolUseId } : {}),
    prompt: task.command, output_file: task.outputFile, session_id: context.sessionId || '',
  })
  return {
    type: 'tool_result',
    tool_use_id: '',
    content: [
      `${automatic ? 'Command exceeded the foreground budget and is continuing in the background' : 'Background process started'}: ${job.id}`,
      `Output is being written to: ${task.outputFile}`,
      'You will be notified when it completes. Do not poll ProcessOutput.',
    ].join('\n'),
    _meta: { execution: runningExecution(task.command, task.outputFile, shellKind(resolveShellInvocation(task.command).command)), task: { id: job.id, status: 'running', kind: 'shell', autoBackgrounded: automatic } },
  }
}

interface ShellTaskResult {
  output: string
  isError: boolean
  execution: ToolExecutionMetadata
}

function toToolResult(result: ShellTaskResult): ToolResult {
  // result.output already carries the single tail budget from assembleShellResult.
  return { type: 'tool_result', tool_use_id: '', content: result.output, ...(result.isError ? { is_error: true } : {}), _meta: { execution: result.execution } }
}

function finishForegroundTask(task: ShellTask, result: ShellTaskResult): ToolResult {
  if (task.job?.jobDir) discardProcessJob(task.job.id)
  return toToolResult(result)
}

function runningExecution(command: string, outputFile: string, shell: 'bash' | 'powershell' = process.platform === 'win32' ? 'powershell' : 'bash'): ToolExecutionMetadata {
  return {
    version: 2,
    outcome: 'running',
    durationMs: 0,
    command: redactSensitiveText(command),
    shell,
    terminationReason: 'running',
    ...(outputFile ? { resultRef: { kind: 'file' as const, path: outputFile, size: 0, mimeType: 'text/plain' } } : {}),
  }
}

async function createExecutionMetadata(input: {
  command: string; purpose?: string; outputFile: string; outputBytes: number; stdoutPreview: string; stderrPreview: string
  code: number | null; startedAt: number; shell: 'bash' | 'powershell'; semanticOutcome?: 'no_matches' | 'condition_false' | 'files_differ'; terminationReason: ToolExecutionMetadata['terminationReason']
}): Promise<ToolExecutionMetadata> {
  let size = input.outputBytes
  try { size = (await stat(input.outputFile)).size } catch { /* keep captured byte count */ }
  const outcome = input.terminationReason === 'completed'
    ? 'succeeded'
    : input.terminationReason === 'timeout'
      ? 'timed_out'
      : input.terminationReason === 'aborted'
        ? 'cancelled'
        : 'failed'
  return {
    version: 2, outcome, exitCode: input.code, stdoutPreview: boundedPreview(input.stdoutPreview), stderrPreview: boundedPreview(input.stderrPreview),
    ...(input.terminationReason === 'timeout' ? { timedOut: true } : {}),
    ...(input.terminationReason === 'aborted' ? { aborted: true } : {}),
    ...(input.terminationReason === 'output_limit' ? { outputLimitReached: true } : {}),
    durationMs: Date.now() - input.startedAt, command: redactSensitiveText(input.command), shell: input.shell,
    ...(input.semanticOutcome ? { semanticOutcome: input.semanticOutcome } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}), terminationReason: input.terminationReason,
    resultRef: { kind: 'file', path: input.outputFile, size, mimeType: 'text/plain' },
  }
}

function executionOutcome(execution: ToolExecutionMetadata): 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted' {
  if (execution.version === 2) return execution.outcome
  if (execution.terminationReason === 'running') return 'running'
  if (execution.terminationReason === 'completed') return 'succeeded'
  if (execution.terminationReason === 'timeout') return 'timed_out'
  if (execution.terminationReason === 'aborted') return 'cancelled'
  return 'failed'
}

function normalizePersistedExecution(
  command: string,
  purpose: string | undefined,
  shell: 'bash' | 'powershell',
  outputFile: string,
  value: unknown,
  startedAt: number,
): ToolExecutionMetadata {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const terminationReason = typeof record.terminationReason === 'string'
    ? record.terminationReason as ToolExecutionMetadata['terminationReason']
    : 'interrupted'
  const inferredOutcome = terminationReason === 'completed'
    ? 'succeeded'
    : terminationReason === 'timeout'
      ? 'timed_out'
      : terminationReason === 'aborted'
        ? 'cancelled'
        : terminationReason === 'running'
          ? 'running'
          : terminationReason === 'interrupted'
            ? 'interrupted'
            : 'failed'
  return {
    ...record,
    version: 2,
    outcome: typeof record.outcome === 'string'
      ? record.outcome as 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled' | 'interrupted'
      : inferredOutcome,
    exitCode: typeof record.exitCode === 'number' || record.exitCode === null ? record.exitCode : null,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : Date.now() - startedAt,
    command: redactSensitiveText(command),
    shell,
    ...(purpose ? { purpose } : {}),
    terminationReason,
    resultRef: record.resultRef && typeof record.resultRef === 'object'
      ? record.resultRef as ToolExecutionMetadata['resultRef']
      : { kind: 'file', path: outputFile, size: 0, mimeType: 'text/plain' },
  } as ToolExecutionMetadata
}

function applySemanticOutcome(
  execution: ToolExecutionMetadata,
  interpretation: ReturnType<typeof interpretShellExit>,
): ToolExecutionMetadata {
  // Without a real exit code (timeout/abort/spawn error) the semantic reading
  // of an exit status cannot apply; doing so would flip failures to succeeded.
  if (typeof execution.exitCode !== 'number' || !interpretation.semanticOutcome || execution.version !== 2) return execution
  return {
    ...execution,
    outcome: 'succeeded' as const,
    semanticOutcome: interpretation.semanticOutcome,
    terminationReason: 'completed',
  }
}

function formatShellResult(
  execution: ToolExecutionMetadata,
  stdoutPreview: string,
  stderrPreview: string,
  interpretation: ReturnType<typeof interpretShellExit>,
  footer?: string,
  outputFile?: string,
): string {
  const outcome = executionOutcome(execution)
  const firstLine = outcome === 'succeeded'
    ? (interpretation.semanticOutcome === 'no_matches'
      ? 'Command completed: no matches found (exit code 1).'
      : `Command completed successfully (exit code ${execution.exitCode ?? 0}${stdoutPreview || stderrPreview ? '' : ', no output'}).`)
    : `Command terminated (${execution.terminationReason}${execution.exitCode !== null && execution.exitCode !== undefined ? `, exit code ${execution.exitCode}` : ''}).`
  return assembleShellResult(
    firstLine,
    [
      stdoutPreview ? `stdout:\n${stdoutPreview}` : '',
      stderrPreview ? `stderr:\n${stderrPreview}` : '',
      ...(footer ? [footer] : []),
    ],
    outcome !== 'succeeded' && execution.exitCode !== null && execution.exitCode !== undefined
      ? `Bash failed (${execution.shell ?? 'bash'}, exit code ${execution.exitCode}): ${interpretation.message}`
      : undefined,
    { outputFile, footer },
  )
}

async function readIncrementalFile(path: string, offset: number): Promise<{ chunk: Buffer; nextOffset: number }> {
  try {
    const info = await stat(path)
    if (info.size <= offset) return { chunk: Buffer.alloc(0), nextOffset: offset }
    const length = Math.min(info.size - offset, 65_536)
    const buffer = Buffer.alloc(length)
    const file = await open(path, 'r')
    try {
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      // Raw bytes: the caller owns decoding so multibyte sequences that span
      // the 64KB block boundary do not turn into U+FFFD (#368).
      return { chunk: buffer.subarray(0, bytesRead), nextOffset: offset + bytesRead }
    } finally {
      await file.close()
    }
  } catch {
    return { chunk: Buffer.alloc(0), nextOffset: offset }
  }
}

function getShellDialectError(command: string, shellCommand: string): string | undefined {
  if (shellKind(shellCommand) !== 'powershell') return undefined
  if (/\bcd\s+\/d\b/i.test(command) || /\bfindstr\b[\s\S]*\|\s*head\b/i.test(command)) {
    return `Bash command was not executed: the current shell is PowerShell, but the command mixes cmd/POSIX syntax (${command.match(/\bcd\s+\/d\b/i)?.[0] ?? 'mixed pipeline'}). Use PowerShell syntax such as Set-Location, Select-String, and Select-Object -Last, or configure an explicit POSIX Bash.`
  }
  return undefined
}

function getVerificationPipelineError(command: string): string | undefined {
  if (!/\|\s*(?:Select-String|findstr|grep|rg|head|tail)\b/i.test(command)) return undefined
  return 'Verification command was not executed: filtered pipelines cannot prove the test, typecheck, or build result. Run the validation command directly and use its structured exit code and output.'
}

function withBundledRipgrepSandbox(sandbox: ToolContext['sandbox']): ToolContext['sandbox'] {
  const directory = bundledRipgrepDirectory()
  if (!directory || !sandbox?.processIsolation?.enabled) return sandbox
  return {
    ...sandbox,
    processIsolation: {
      ...sandbox.processIsolation,
      executableSearchPaths: [directory, ...(sandbox.processIsolation.executableSearchPaths ?? [])],
      readonlyPaths: [directory, ...(sandbox.processIsolation.readonlyPaths ?? [])],
    },
  }
}

/** 'complex' = non-provable syntax; otherwise the matched excluded executable. */
function checkExcludedCommands(command: string, excluded: string[]): string | 'complex' | undefined {
  const lower = new Set(excluded.map((value) => value.toLowerCase()))
  const analysis = analyzeBashCommand(command)
  if (analysis.status !== 'simple') {
    // Command substitution, subshells, and nested statements can hide an
    // excluded executable from any textual scan; refuse rather than miss one (#338).
    return 'complex'
  }
  return analysis.commands.map((segment) => segment.executable).find((name) => lower.has(name))
}

interface TailTruncation {
  content: string
  truncated: boolean
  truncatedByLines: boolean
  truncatedByChars: boolean
  totalLines: number
  shownLines: number
  /** Character counts in UTF-16 code units, matching the char budget semantics. */
  totalChars: number
  shownChars: number
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function countNewlines(text: string): number {
  let count = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count += 1
  return count
}

/** Lines by terminator semantics: a trailing newline terminates the last line instead of starting an empty one. */
function countTerminatedLines(text: string): number {
  if (!text) return 0
  return text.endsWith('\n') ? countNewlines(text) : countNewlines(text) + 1
}

/** Keep only the last `maxLines` terminated lines (shared: tailTruncate + raw accumulator window). */
function keepLastLines(text: string, maxLines: number): { content: string; dropped: boolean } {
  if (countTerminatedLines(text) <= maxLines) return { content: text, dropped: false }
  const hadTrailingNewline = text.endsWith('\n')
  const segments = text.split('\n')
  const realLines = hadTrailingNewline ? segments.slice(0, -1) : segments
  return {
    content: realLines.slice(-maxLines).join('\n') + (hadTrailingNewline ? '\n' : ''),
    dropped: true,
  }
}

/**
 * Shared tail-window cutter: UTF-16 slice that restarts at the next line break
 * when one exists and never leaves a split surrogate pair at either edge.
 * Within-budget input passes through untouched (the line restart is part of
 * the cut, not a normalization).
 */
function cutTailWithinBudget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  let out = content.slice(-maxChars)
  const newlineAt = out.indexOf('\n')
  if (newlineAt >= 0 && newlineAt < out.length - 1) out = out.slice(newlineAt + 1)
  if (isLowSurrogate(out.charCodeAt(0))) out = out.slice(1)
  if (isHighSurrogate(out.charCodeAt(out.length - 1))) out = out.slice(0, -1)
  return out
}

/**
 * Keep the tail of `text` within both bounds, whichever bites first (command
 * errors live at the end, so the tail is the useful half). Redacts first; caps
 * are measured in characters (UTF-16 code units). A char-boundary cut restarts
 * at the next line break when one exists and never leaves a split surrogate
 * pair at either edge. `truncated` reflects caps that actually bit on the raw
 * stream — redaction growing a within-budget stream past the budget runs the
 * guard cut without counting as truncation.
 */
export function tailTruncate(text: string, maxLines: number, maxChars: number): TailTruncation {
  const value = redactSensitiveText(text)
  const totalLines = countTerminatedLines(value)
  let content = value
  let truncatedByLines = false
  let truncatedByChars = false
  const lineCapped = keepLastLines(value, maxLines)
  content = lineCapped.content
  truncatedByLines = lineCapped.dropped
  if (content.length > maxChars) {
    const rawOverBudget = text.length > maxChars
    content = cutTailWithinBudget(content, maxChars)
    truncatedByChars = rawOverBudget
  }
  return {
    content,
    truncated: truncatedByLines || truncatedByChars,
    truncatedByLines,
    truncatedByChars,
    totalLines,
    shownLines: countTerminatedLines(content),
    totalChars: value.length,
    shownChars: content.length,
  }
}

type PreviewAccumulator = ReturnType<typeof createPreviewAccumulator>

// ============================================================================
// Streaming secret redaction — TWO chained single-pattern state machines that
// compose into EXACTLY redactSensitiveText's two sequential replaces:
//
//   machineA (bearer): /(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi   → $1[redacted]
//   machineB (kv):     ((api[_-]?key|token|secret|password)\s*[:=]\s*)([^\s,;]+) → $1[redacted]
//
// redactSensitiveText applies the bearer pass first and the kv pass to its
// output; feeding raw chars through A→B reproduces that byte-for-byte, because
// each machine echoes every non-matching char verbatim (so B sees precisely the
// text pass 1 produced). Two machines — not one merged FSM — is what makes
// nested prefixes (`token=Bearer x`) and per-pattern value charsets correct.
//
// Per-machine state is O(1): mode + ≤8-char keyword staging buffer. Value runs
// are suppressed without storage (arbitrarily long tokens cost nothing), and
// failed prefixes RE-FEED the offending char into the machine's own OUT state
// so adjacent keywords (`BearerBearer`) are never swallowed.
// ============================================================================

const BEARER_VALUE_CHARS = /[A-Za-z0-9._~+/=-]/
const KV_VALUE_TERMINATORS = /[\s,;]/

interface SecretMachine {
  feed(ch: string): void
  /** Uncommitted plain-text fragment (a possible keyword head) awaiting more input. */
  hold(): string
}

function isWhitespaceChar(ch: string): boolean {
  return /\s/.test(ch)
}

const MAX_KEYWORD_LENGTH = 8 // 'password' — bounds the suffix-retry window

function createSecretMachine(
  sink: (chunk: string) => void,
  kind: 'bearer' | 'kv',
): SecretMachine {
  const keywords = kind === 'bearer' ? ['bearer'] : ['api_key', 'api-key', 'apikey', 'token', 'secret', 'password']
  const isValueChar = kind === 'bearer'
    ? (ch: string) => BEARER_VALUE_CHARS.test(ch)
    : (ch: string) => !KV_VALUE_TERMINATORS.test(ch)

  let mode: 'out' | 'prefixTail' | 'inValue' = 'out'
  let stage = ''
  let phase: 'pre' | 'post' = 'pre' // kv only: whitespace before vs after [:=]
  let wsSeen = 0 // bearer only

  function matchedKeyword(lower: string): boolean {
    return keywords.some((keyword) => keyword === lower)
  }

  function isKeywordPartial(lower: string): boolean {
    if (!lower) return true
    return keywords.some((keyword) => keyword.startsWith(lower))
  }

  function feed(ch: string): void {
    if (mode === 'inValue') {
      if (isValueChar(ch)) return // suppressed secret body
      // Terminator leaves the value run and re-enters OUT staging — feed it,
      // don't emit it (feeding routes the char exactly once).
      mode = 'out'
      feed(ch)
      return
    }
    if (mode === 'prefixTail') {
      if (isWhitespaceChar(ch)) {
        if (kind === 'bearer') wsSeen += 1
        emit(ch)
        return
      }
      if (kind === 'bearer' && wsSeen === 0) {
        // 'Bearer' without whitespace → no match here; re-read ch from OUT.
        mode = 'out'
        feed(ch)
        return
      }
      if (kind === 'kv' && phase === 'pre') {
        if (ch === ':' || ch === '=') {
          phase = 'post'
          emit(ch)
          return
        }
        mode = 'out'
        feed(ch)
        return
      }
      // First value char decides: match completes or the whole attempt was
      // plain text — either way ch routes onward without being swallowed.
      if (isValueChar(ch)) {
        sink('[redacted]')
        mode = 'inValue'
        return
      }
      mode = 'out'
      feed(ch)
      return
    }
    // OUT: stage a possible keyword; on an impossible candidate emit the
    // shortest head that still leaves the longest valid keyword SUFFIX held —
    // a later keyword may start inside the failed candidate (`apikey` failing
    // mid-way must not blind the machine to a following `api_key=`).
    let buf = stage + ch
    for (;;) {
      const lower = buf.toLowerCase()
      if (matchedKeyword(lower)) {
        emit(buf)
        stage = ''
        mode = 'prefixTail'
        phase = 'pre'
        wsSeen = 0
        return
      }
      if (lower === '') break
      if (isKeywordPartial(lower)) break
      let keepFrom = -1
      for (let s = Math.max(1, buf.length - MAX_KEYWORD_LENGTH); s < buf.length; s += 1) {
        const suffixLower = buf.slice(s).toLowerCase()
        if (matchedKeyword(suffixLower) || isKeywordPartial(suffixLower)) {
          keepFrom = s
          break
        }
      }
      if (keepFrom === -1) {
        emit(buf)
        buf = ''
      } else {
        emit(buf.slice(0, keepFrom))
        buf = buf.slice(keepFrom)
      }
    }
    stage = buf
  }

  function emit(chunk: string): void {
    sink(chunk)
  }

  return {
    feed,
    hold(): string {
      return mode === 'out' ? stage : ''
    },
  }
}

// Memory guard for the incremental buffer: the AUTHORITATIVE char budget is
// applied per-snapshot (after the line trim, matching the single-shot pipeline
// order — applying it incrementally would drop chars the final line-window
// keeps and break byte equivalence). Between snapshots the buffer is therefore
// only bounded by lines + this slack; a stream whose last `maxLines` lines
// exceed it gets conservatively over-trimmed (footer still tells the truth).
// ponytail: raise the slack or page to disk if huge single lines ever matter.
const PREVIEW_MEMORY_SLACK_CHARS = 65_536

export function createPreviewAccumulator(maxLines: number, maxChars: number) {
  let kept = ''
  let totalNewlines = 0
  let totalChars = 0
  let streamEndsWithNewline = false
  let sawAnyOutput = false
  let droppedLines = false
  let droppedChars = false
  // Chained machines reproduce redactSensitiveText's pass order: bearer first,
  // kv pass consuming pass-one's output.
  let kvFeed: (ch: string) => void = () => {}
  const machineA = createSecretMachine((chunk) => {
    for (const ch of chunk) kvFeed(ch)
  }, 'bearer')
  const machineB = createSecretMachine((chunk) => {
    kept += chunk
  }, 'kv')
  kvFeed = machineB.feed

  return {
    append(text: string): void {
      if (!text) return
      sawAnyOutput = true
      totalNewlines += countNewlines(text)
      totalChars += text.length
      streamEndsWithNewline = text.endsWith('\n')
      for (const ch of text) machineA.feed(ch)
      let candidate = kept
      const lineCapped = keepLastLines(candidate, maxLines)
      candidate = lineCapped.content
      droppedLines ||= lineCapped.dropped
      const memoryCap = maxChars + PREVIEW_MEMORY_SLACK_CHARS
      if (candidate.length > memoryCap) {
        candidate = cutTailWithinBudget(candidate, memoryCap)
        droppedChars = true
      }
      kept = candidate
    },
    snapshot(): TailTruncation {
      // Both machines' uncommitted keyword-head fragments are plain text not
      // yet routed — show them for display continuity. Chronological order:
      // B holds fragments of A's *emitted* stream (older), A holds raw-tail
      // fragments (newer).
      const fresh = tailTruncate(kept + machineB.hold() + machineA.hold(), maxLines, maxChars)
      return {
        ...fresh,
        truncated: droppedLines || droppedChars || fresh.truncated,
        truncatedByLines: droppedLines || fresh.truncatedByLines,
        truncatedByChars: droppedChars || fresh.truncatedByChars,
        // Full-stream totals survive the tail windowing.
        totalLines: sawAnyOutput ? totalNewlines + (streamEndsWithNewline ? 0 : 1) : 0,
        totalChars,
        shownChars: fresh.content.length,
      }
    },
  }
}

/** Combined live view of both streams, bounded tighter than the result previews. */
function combinedStreamSnapshot(stdout: PreviewAccumulator, stderr: PreviewAccumulator): string {
  const out = stdout.snapshot().content
  const err = stderr.snapshot().content
  if (!out && !err) return ''
  return cutTailWithinBudget(out && err ? `${out}\n${err}` : out || err, STREAM_SNAPSHOT_MAX_CHARS)
}

function truncationFooter(stdout: TailTruncation, stderr: TailTruncation, outputFile: string): string | undefined {
  const describe = (stats: TailTruncation): string | undefined => {
    if (stats.truncatedByLines) return `last ${stats.shownLines} of ${stats.totalLines} lines`
    if (stats.truncatedByChars) return `last ${stats.shownChars} of ${stats.totalChars} characters`
    return undefined
  }
  const stdoutPhrase = describe(stdout)
  const stderrPhrase = describe(stderr)
  if (!stdoutPhrase && !stderrPhrase) return undefined
  if (stdoutPhrase && stderrPhrase) {
    return `[Showing ${stdoutPhrase} (stdout) and ${stderrPhrase} (stderr). Full output: ${outputFile}]`
  }
  return `[Showing ${stdoutPhrase ?? stderrPhrase}. Full output: ${outputFile}]`
}

/**
 * Assemble the model-visible result with ONE structural tail budget over the
 * output body: header/failure-note space is reserved up front, and when the
 * body still overflows the trim announces itself — either via the caller's
 * per-stream footer (already part of the body tail) or a fallback footer naming
 * the full-output file. A cut can therefore never happen silently.
 */
function assembleShellResult(
  firstLine: string,
  bodySections: string[],
  failureNote: string | undefined,
  truncationInfo?: { outputFile?: string; footer?: string },
): string {
  const body = bodySections.filter(Boolean).join('\n')
  const budget = MAX_RESULT_CHARS - firstLine.length - (failureNote?.length ?? 0) - 96 /* footer/labels reserve */
  if (body.length <= budget) {
    return [firstLine, body, failureNote].filter(Boolean).join('\n') || '(no output)'
  }
  const boundedBody = cutTailWithinBudget(body, Math.max(0, budget))
  if (truncationInfo?.footer) {
    // Per-stream footer already rides the body tail and survived the cut.
    return [firstLine, boundedBody, failureNote].filter(Boolean).join('\n')
  }
  const fallbackFooter = truncationInfo?.outputFile
    ? `[Output truncated to fit the result budget. Full output: ${truncationInfo.outputFile}]`
    : '[Output truncated to fit the result budget.]'
  return [firstLine, boundedBody, fallbackFooter, failureNote].filter(Boolean).join('\n')
}

/**
 * Trailing-edge throttle for live output snapshots: bursts collapse
 * into one snapshot per window; a quiet period flushes immediately. Prefers the
 * live channel and falls back to the buffered one when the host has no live
 * receiver. Events carry tool_use_id so the UI can pin them to the running card.
 */
function createStreamSnapshotEmitter(context: ToolContext, getSnapshot: () => string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  let lastEmitAt = 0
  const emit = () => {
    dirty = false
    lastEmitAt = Date.now()
    ;(context.emitLiveEvent ?? context.emitEvent)?.({
      type: 'system',
      subtype: 'local_command_output',
      content: getSnapshot(),
      ...(context.toolUseId ? { tool_use_id: context.toolUseId } : {}),
      session_id: context.sessionId || '',
    })
  }
  return {
    schedule(): void {
      if (!context.emitLiveEvent && !context.emitEvent) return
      dirty = true
      const delay = STREAM_SNAPSHOT_THROTTLE_MS - (Date.now() - lastEmitAt)
      if (delay <= 0) {
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        emit()
        return
      }
      timer ??= setTimeout(() => {
        timer = undefined
        emit()
      }, delay)
      timer.unref?.()
    },
    /** Emit any pending snapshot now (tool finishing); safe to call repeatedly. */
    flush(): void {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (dirty) emit()
    },
  }
}

function boundedPreview(value: string, maxChars = PREVIEW_CHARS): string {
  value = redactSensitiveText(value)
  if (value.length <= maxChars) return value
  const half = Math.floor(maxChars / 2)
  return `${value.slice(0, half)}\n...(truncated)...\n${value.slice(-half)}`
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
}

export function interpretShellExit(command: string, exitCode: number): { isError: boolean; message: string; semanticOutcome?: 'no_matches' | 'condition_false' | 'files_differ' } {
  const lastCommand = command.split(/\r?\n|&&|\|\||[|;&]/).map((part) => part.trim()).filter(Boolean).pop() || command.trim()
  const executable = lastCommand.match(/^(?:['"]([^'"]+)['"]|(\S+))/)?.slice(1).find(Boolean) || ''
  const name = executable.split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
  if (exitCode === 1 && (name === 'grep' || name === 'rg' || name === 'findstr' || name === 'select-string')) return { isError: false, message: 'No matches found', semanticOutcome: 'no_matches' }
  if (exitCode === 1 && (name === 'diff' || name === 'test' || name === '[')) return { isError: false, message: name === 'diff' ? 'Files differ' : 'Condition is false', semanticOutcome: name === 'diff' ? 'files_differ' : 'condition_false' }
  return { isError: exitCode !== 0, message: `Exit code: ${exitCode}` }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
