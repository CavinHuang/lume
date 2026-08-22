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
import { resolveShellInvocation } from '../utils/shell-invocation.js'
import { spawnWithProcessSandbox, terminateProcessTree } from '../utils/process-sandbox.js'

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024
const MAX_RESULT_CHARS = 100_000
const PREVIEW_CHARS = 4_000
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
    const blocked = findBlockedCommand(command, context.sandbox?.excludedCommands ?? [])
    if (blocked) return { data: `Sandbox blocked command prefix "${blocked}"`, is_error: true }
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

function isReadOnlyShellInput(input: unknown, _context?: ToolContext): boolean {
  if (!input || typeof input !== 'object') return false
  const command = (input as Record<string, unknown>).command
  if (typeof command !== 'string' || !command.trim()) return false
  const normalized = command.trim()

  // These constructs can execute arbitrary code or write through the shell,
  // even when the visible command starts with a read-looking executable.
  if (/[>`]|>>|\$\(|`/.test(normalized)) return false

  const analysis = analyzeBashCommand(normalized)
  if (analysis.status === 'simple') {
    return analysis.commands.length > 0
      && analysis.commands.every((segment) => isReadOnlySegment(segment.executable, segment.argv.slice(1)))
      && !analysis.hasRedirection
  }

  // PowerShell is intentionally parsed conservatively by the native Bash
  // parser. Cover the small, unambiguous inspection subset so Windows reads
  // do not inherit Bash's blanket mutating classification.
  return isReadOnlyPowerShell(normalized)
}

const READ_ONLY_EXECUTABLES = new Set([
  'cat', 'cut', 'dir', 'echo', 'find', 'findstr', 'git', 'grep', 'head', 'less', 'ls', 'pwd',
  'rg', 'sed', 'sort', 'tail', 'type', 'uniq', 'wc', 'where', 'which',
])

function isReadOnlySegment(executable: string, args: string[]): boolean {
  if (!READ_ONLY_EXECUTABLES.has(executable)) return false
  if (executable === 'git') {
    const subcommandIndex = args.findIndex((arg) => !arg.startsWith('-'))
    if (subcommandIndex < 0) return false
    const subcommand = args[subcommandIndex]!
    if (!new Set(['branch', 'diff', 'log', 'show', 'status']).has(subcommand)) return false
    const rest = args.slice(subcommandIndex + 1)
    if (subcommand === 'branch') {
      // Only listing forms are reads: an operand names a branch to create,
      // and delete/move/copy/set-upstream flags mutate refs (#300).
      if (rest.some((arg) => !arg.startsWith('-') && arg !== '--')) return false
      return !rest.some((arg) => (
        /^-[dDmMcCu]/.test(arg)
        || /^--(?:delete|move|copy|set-upstream(?:-to)?|edit-description|track)\b/.test(arg)
      ))
    }
    if (subcommand === 'diff') {
      // --output writes the diff to a file; --ext-diff executes a
      // repo-config-controlled external diff command (#300).
      return !rest.some((arg) => arg === '--output' || arg.startsWith('--output=') || arg === '--ext-diff')
    }
    return true
  }
  // These whitelist members have argument forms that mutate or execute;
  // reject them so they cannot race Edit/Write as "read-only" work.
  if (executable === 'find') return !args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fls|fprint)/.test(arg))
  if (executable === 'sed') return isReadOnlySedArgs(args)
  if (executable === 'sort') return !args.some((arg) => (
    arg === '--output'
    || arg.startsWith('--output=')
    // No other short sort flag is "o", so any short cluster containing it is -o.
    // grep -o is unrelated: grep arguments are never checked here.
    || (arg.startsWith('-') && !arg.startsWith('--') && arg.includes('o'))
  ))
  if (executable === 'uniq') {
    // uniq [INPUT [OUTPUT]] — a second operand names the output file it writes (#300).
    return args.filter((arg) => !arg.startsWith('-') && arg !== '--').length <= 1
  }
  return true
}

function isReadOnlySedArgs(args: string[]): boolean {
  if (args.some((arg) => /^(-i|--in-place)/.test(arg))) return false
  return !sedScriptArgs(args).some(sedScriptWritesFile)
}

/** Collect the script arguments (not the input file paths) sed will execute. */
function sedScriptArgs(args: string[]): string[] {
  const scripts: string[] = []
  let pending: 'script' | 'skip' | undefined
  let sawScript = false
  let endOfOptions = false
  for (const arg of args) {
    if (pending) {
      if (pending === 'script') scripts.push(arg)
      pending = undefined
      continue
    }
    if (!endOfOptions && arg === '--') {
      endOfOptions = true
      continue
    }
    if (!endOfOptions && arg.startsWith('--')) {
      if (arg.startsWith('--expression=')) {
        scripts.push(arg.slice('--expression='.length))
        sawScript = true
      } else if (arg === '--expression') {
        pending = 'script'
        sawScript = true
      } else if (arg === '--file') {
        // --file names a script file; the next argument is not a script body.
        pending = 'skip'
      }
      continue
    }
    if (!endOfOptions && arg.startsWith('-') && arg.length > 1) {
      const cluster = arg.slice(1)
      const flagIndex = cluster.search(/[ef]/)
      if (flagIndex >= 0) {
        if (flagIndex < cluster.length - 1) {
          if (cluster[flagIndex] === 'e') {
            scripts.push(cluster.slice(flagIndex + 1))
            sawScript = true
          }
        } else {
          pending = cluster[flagIndex] === 'e' ? 'script' : 'skip'
          if (cluster[flagIndex] === 'e') sawScript = true
        }
      }
      continue
    }
    if (!sawScript) {
      scripts.push(arg)
      sawScript = true
    }
  }
  return scripts
}

/**
 * Recognize sed script forms that write files or execute commands: a
 * standalone `w`/`W`/`e` command or the same as an `s` suffix. Only command
 * positions are inspected, so patterns, replacements, append text, and file
 * paths that merely contain those letters do not trip the check.
 */
function sedScriptWritesFile(script: string): boolean {
  const isDangerousCommand = (char: string | undefined) => char === 'w' || char === 'W' || char === 'e'
  const length = script.length
  let i = 0
  let atCommand = true
  while (i < length) {
    const char = script[i]!
    if (char === ';' || char === '\n') {
      atCommand = true
      i += 1
      continue
    }
    if (!atCommand) {
      i += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '{' || char === '}' || char === '!') {
      i += 1
      continue
    }
    if (char === '#') {
      while (i < length && script[i] !== '\n') i += 1
      continue
    }
    // Addresses: /re/, line numbers, $, ranges, and custom \cREc delimiters.
    if (char === '/') {
      i += 1
      while (i < length && script[i] !== '/') i += script[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (char === '\\') {
      const delimiter = script[i + 1]
      i += 2
      while (i < length && script[i] !== delimiter) i += script[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if ((char >= '0' && char <= '9') || char === '$' || char === ',') {
      i += 1
      continue
    }
    if (isDangerousCommand(char)) return true
    if (char === 's' || char === 'y') {
      const delimiter = script[i + 1]
      if (!delimiter) return false
      i += 2
      // s has two fields (regex, replacement); y has three (src, dst, then a
      // closing delimiter). Each field scan ends at its own delimiter.
      for (let field = 0; field < (char === 's' ? 2 : 3); field += 1) {
        while (i < length && script[i] !== delimiter) i += script[i] === '\\' ? 2 : 1
        i += 1
      }
      while (i < length && /[a-zA-Z0-9]/.test(script[i]!)) {
        if (isDangerousCommand(script[i])) return true
        i += 1
      }
      continue
    }
    // Any other command consumes the rest of the line as its argument
    // (r/w-style filenames, labels, a\i\c text).
    atCommand = false
    i += 1
  }
  return false
}

function isReadOnlyPowerShell(command: string): boolean {
  const normalized = command
    .replace(/^\s*(?:powershell|pwsh)(?:\.exe)?\s+(?:-NoLogo\s+|-NoProfile\s+|-NonInteractive\s+)*-Command\s+/i, '')
    .trim()
  if (!normalized || /[>`]|>>|\$\(|;|\b(?:Set|Remove|Copy|Move|New|Add|Clear|Out|Start|Stop|Invoke|Install|Update)-[A-Za-z]+\b/i.test(normalized)) {
    return false
  }
  // Unparsed strings cannot be arg-checked, so only git subcommands whose
  // common forms never take mutation targets survive here; branch/diff move
  // to the parsed path only (#300).
  return /^(?:Get-(?:ChildItem|Content|Location|Item|ItemProperty|Process|Service|Command|Date|Help|Member|Variable|Acl|FileHash|AuthenticodeSignature|ComputerInfo)|Select-String|Where-Object|Test-Path|Resolve-Path|Measure-Object|Sort-Object|Format-(?:Table|List)|Write-Output|Write-Host|git\s+(?:status|log|show)\b|(?:ls|dir|type|cat|pwd|where|findstr)\b)/i.test(normalized)
}

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
  let stdoutPreview = ''
  let stderrPreview = ''
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
      if (stream === 'stdout') stdoutPreview = appendPreview(stdoutPreview, text)
      else stderrPreview = appendPreview(stderrPreview, text)
      writeChain = writeChain.then(() => appendFile(outputFile, accepted))
      context.emitEvent?.({
        type: 'system',
        subtype: 'local_command_output',
        content: boundedPreview(text),
        session_id: context.sessionId || '',
      })
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
  const timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs)
  timeoutTimer.unref?.()
  const abortHandler = () => stop('aborted')
  context.abortSignal?.addEventListener('abort', abortHandler, { once: true })
  proc.stdout?.on('data', (chunk: Buffer) => appendOutput('stdout', chunk))
  proc.stderr?.on('data', (chunk: Buffer) => appendOutput('stderr', chunk))

  const done = new Promise<ShellTaskResult>((resolve) => {
    const finish = async (code: number | null, spawnError?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      context.abortSignal?.removeEventListener('abort', abortHandler)
      if (progressTimer) clearInterval(progressTimer)
      const stdoutTail = stdoutDecoder.end()
      const stderrTail = stderrDecoder.end()
      if (stdoutTail) stdoutPreview = appendPreview(stdoutPreview, stdoutTail)
      if (stderrTail) stderrPreview = appendPreview(stderrPreview, stderrTail)
      if (spawnError) stderrPreview = appendPreview(stderrPreview, spawnError)
      await writeChain.catch(() => undefined)
      const interpretation = interpretShellExit(command, code ?? 1)
      if (terminationReason === 'completed' && code !== 0 && interpretation.isError) terminationReason = 'nonzero'
      if (spawnError) terminationReason = 'spawn_error'
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
      const output = [
        terminationReason === 'completed'
          ? (interpretation.semanticOutcome === 'no_matches'
            ? 'Command completed: no matches found (exit code 1).'
            : `Command completed successfully (exit code ${code ?? 0}${stdoutPreview || stderrPreview ? '' : ', no output'}).`)
          : `Command terminated (${terminationReason}${code !== null ? `, exit code ${code}` : ''}).`,
        stdoutPreview ? `stdout:\n${stdoutPreview}` : '',
        stderrPreview ? `stderr:\n${stderrPreview}` : '',
        spawnError ? `process error: ${spawnError}` : '',
        code !== 0 && code !== null
          ? `Bash failed (${shellType}, exit code ${code}): ${interpretation.message}`
          : '',
      ].filter(Boolean).join('\n') || '(no output)'
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
        const tail = `${stdoutPreview}\n${stderrPreview}`.trimEnd()
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
  let stdoutPreview = ''
  let stderrPreview = ''
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
    if (stdout.text) {
      lastOutputAt = Date.now()
      stdoutPreview = appendPreview(stdoutPreview, stdout.text)
      context.emitEvent?.({
        type: 'system',
        subtype: 'local_command_output',
        content: boundedPreview(stdout.text),
        session_id: context.sessionId || '',
      })
    }
    const stderr = await readIncrementalFile(stderrFile, stderrOffset)
    stderrOffset = stderr.nextOffset
    if (stderr.text) {
      lastOutputAt = Date.now()
      stderrPreview = appendPreview(stderrPreview, stderr.text)
      context.emitEvent?.({
        type: 'system',
        subtype: 'local_command_output',
        content: boundedPreview(stderr.text),
        session_id: context.sessionId || '',
      })
    }
    const combined = await readIncrementalFile(outputFile, outputOffset, false)
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
        const output = formatShellResult(normalizedExecution, stdoutPreview, stderrPreview, interpretation)
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
        const tail = `${stdoutPreview}\n${stderrPreview}`.trimEnd()
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
  return { type: 'tool_result', tool_use_id: '', content: boundedPreview(result.output, MAX_RESULT_CHARS), ...(result.isError ? { is_error: true } : {}), _meta: { execution: result.execution } }
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
): string {
  const outcome = executionOutcome(execution)
  const firstLine = outcome === 'succeeded'
    ? (interpretation.semanticOutcome === 'no_matches'
      ? 'Command completed: no matches found (exit code 1).'
      : `Command completed successfully (exit code ${execution.exitCode ?? 0}${stdoutPreview || stderrPreview ? '' : ', no output'}).`)
    : `Command terminated (${execution.terminationReason}${execution.exitCode !== null && execution.exitCode !== undefined ? `, exit code ${execution.exitCode}` : ''}).`
  return [
    firstLine,
    stdoutPreview ? `stdout:\n${stdoutPreview}` : '',
    stderrPreview ? `stderr:\n${stderrPreview}` : '',
    outcome !== 'succeeded' && execution.exitCode !== null && execution.exitCode !== undefined
      ? `Bash failed (${execution.shell ?? 'bash'}, exit code ${execution.exitCode}): ${interpretation.message}`
      : '',
  ].filter(Boolean).join('\n') || '(no output)'
}

async function readIncrementalFile(path: string, offset: number, decode = true): Promise<{ text: string; nextOffset: number }> {
  try {
    const info = await stat(path)
    if (info.size <= offset) return { text: '', nextOffset: offset }
    const length = Math.min(info.size - offset, 65_536)
    const buffer = Buffer.alloc(length)
    const file = await open(path, 'r')
    try {
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      return {
        text: decode ? buffer.subarray(0, bytesRead).toString('utf8') : '',
        nextOffset: offset + bytesRead,
      }
    } finally {
      await file.close()
    }
  } catch {
    return { text: '', nextOffset: offset }
  }
}

function shellKind(command: string): 'bash' | 'powershell' {
  return /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(command) ? 'powershell' : 'bash'
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

function findBlockedCommand(command: string, excluded: string[]): string | undefined {
  const lower = new Set(excluded.map((value) => value.toLowerCase()))
  if (lower.size === 0) return undefined
  const analysis = analyzeBashCommand(command)
  if (analysis.status === 'simple') {
    return analysis.commands.map((segment) => segment.executable).find((name) => lower.has(name))
  }
  const matches = command.matchAll(/(?:^|[;&|]\s*|\n\s*)(?:(?:[A-Za-z_][\w]*=\S+)\s+)*(?:['"]([^'"]+)['"]|(\S+))/g)
  for (const match of matches) {
    const name = (match[1] || match[2] || '').split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
    if (name && lower.has(name)) return name
  }
  return undefined
}

function appendPreview(current: string, value: string): string {
  return boundedPreview(`${current}${value}`, MAX_RESULT_CHARS)
}

function boundedPreview(value: string, maxChars = PREVIEW_CHARS): string {
  value = redactSensitiveText(value)
  if (value.length <= maxChars) return value
  const half = Math.floor(maxChars / 2)
  return `${value.slice(0, half)}\n...(truncated)...\n${value.slice(-half)}`
}

function redactSensitiveText(value: string): string {
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
