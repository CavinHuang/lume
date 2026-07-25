/** Execute shell commands with one lifecycle for foreground and background work. */

import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessJobRecord, registerProcessStopHandler, unregisterProcessStopHandler, updateProcessJob } from './process-job-registry.js'
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

type ShellTask = Awaited<ReturnType<typeof startShellTask>>

export const BashTool = defineTool({
  name: 'Bash',
  description: 'Execute a bash command and return its output. On Windows, use a POSIX bash when available; otherwise commands run through cmd.exe. Invoke PowerShell explicitly when PowerShell syntax is required.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute. Prefer POSIX syntax; on Windows, use PowerShell explicitly instead of mixing cmd.exe and PowerShell syntax.' },
      timeout: { type: 'number', description: 'Optional timeout in milliseconds (max 600000, default 120000)' },
      description: { type: 'string', description: 'Short description for background task tracking' },
      run_in_background: { type: 'boolean', description: 'Run the command in the background and return a task ID immediately' },
      purpose: { type: 'string', description: 'Optional execution purpose, e.g. verification' },
    },
    required: ['command'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  validateInput(input) {
    if (!input || typeof input !== 'object') return 'Input must be an object.'
    if (typeof input.command !== 'string' || !input.command.trim()) return 'command is required.'
    if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0)) return 'timeout must be a positive number.'
    if (input.run_in_background !== undefined && typeof input.run_in_background !== 'boolean') return 'run_in_background must be a boolean.'
  },
  async call(input, context) {
    const command = String(input.command)
    const timeoutMs = Math.min(Number(input.timeout ?? 120_000), 600_000)
    const purpose = typeof input.purpose === 'string' && input.purpose.trim() ? input.purpose.trim() : undefined
    const blocked = findBlockedCommand(command, context.sandbox?.excludedCommands ?? [])
    if (blocked) return { data: `Sandbox blocked command prefix "${blocked}"`, is_error: true }

    const task = await startShellTask({ command, timeoutMs, purpose, context })
    if (input.run_in_background) return promoteToBackground(task, input.description, context)

    const initial = await Promise.race([
      task.done,
      delay(PROGRESS_THRESHOLD_MS).then(() => null),
    ])
    if (initial) return toToolResult(initial)

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
    if (completion) return toToolResult(completion)
    return promoteToBackground(task, input.description, context, true)
  },
})

async function startShellTask({
  command,
  timeoutMs,
  purpose,
  context,
}: {
  command: string
  timeoutMs: number
  purpose?: string
  context: ToolContext
}) {
  const outputDirectory = context.artifactsRoot ? join(context.artifactsRoot, 'tool-results') : tmpdir()
  await mkdir(outputDirectory, { recursive: true })
  const outputFile = join(outputDirectory, `bash-${context.sessionId || 'session'}-${Date.now()}-${crypto.randomUUID()}.log`)
  await writeFile(outputFile, '', 'utf8')

  const shell = resolveShellInvocation(command)
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
  let terminationReason: ToolExecutionMetadata['terminationReason'] = 'completed'
  let settled = false
  let writeChain = Promise.resolve()
  let attachedTaskId: string | undefined
  let progressTimer: ReturnType<typeof setInterval> | undefined
  let completedResult: ShellTaskResult | undefined

  const completeBackgroundTask = (result: ShellTaskResult) => {
    if (!attachedTaskId) return
    const status = result.execution.terminationReason === 'completed' ? 'completed'
      : result.execution.terminationReason === 'aborted' ? 'stopped' : 'failed'
    updateProcessJob(attachedTaskId, { status, output: boundedPreview(result.output, MAX_RESULT_CHARS), metadata: { execution: result.execution } })
    unregisterProcessStopHandler(attachedTaskId)
    context.emitEvent?.({
      type: 'system', subtype: 'task_notification', task_id: attachedTaskId,
      status: status === 'completed' ? 'completed' : 'failed', output_file: outputFile,
      summary: status === 'completed' ? 'Task completed' : `Task ${result.execution.terminationReason}`,
      execution: result.execution, session_id: context.sessionId || '',
    } as any)
    context.onBackgroundTaskCompleted?.()
  }

  const appendOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (settled) return
    const remaining = MAX_OUTPUT_BYTES - outputBytes
    const accepted = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0)
    outputBytes += accepted.length
    if (accepted.length > 0) {
      const text = accepted.toString('utf8')
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
      if (spawnError) stderrPreview = appendPreview(stderrPreview, spawnError)
      await writeChain.catch(() => undefined)
      const interpretation = interpretShellExit(command, code ?? 1)
      if (terminationReason === 'completed' && code !== 0 && interpretation.isError) terminationReason = 'nonzero'
      if (spawnError) terminationReason = 'spawn_error'
      const execution = await createExecutionMetadata({
        command,
        purpose,
        outputFile,
        outputBytes,
        stdoutPreview,
        stderrPreview,
        code,
        startedAt,
        terminationReason,
      })
      const output = [stdoutPreview, stderrPreview, spawnError, code !== 0 && code !== null ? interpretation.message : '']
        .filter(Boolean).join('\n') || '(no output)'
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
    done,
    promote(taskId: string, subject: string) {
      if (attachedTaskId) return
      attachedTaskId = taskId
      registerProcessStopHandler(taskId, () => stop('aborted'))
      if (completedResult) {
        completeBackgroundTask(completedResult)
        return
      }
      progressTimer = setInterval(() => {
        context.emitEvent?.({
          type: 'system', subtype: 'task_progress', task_id: taskId, description: subject,
          last_tool_name: 'Bash', usage: { total_tokens: 0, tool_uses: 1, duration_ms: Date.now() - startedAt },
          session_id: context.sessionId || '',
        })
      }, 1_000)
      progressTimer.unref?.()
      proc.unref()
    },
  }
}

async function promoteToBackground(task: ShellTask, description: unknown, context: ToolContext, automatic = false): Promise<ToolResult> {
  const subject = typeof description === 'string' && description.trim() ? description.trim() : 'Background shell command'
  const job = createProcessJobRecord({
    subject,
    description: task.command,
    status: 'running',
    outputFile: task.outputFile,
    taskType: 'shell',
    metadata: { execution: runningExecution(task.command, task.outputFile) },
  })
  task.promote(job.id, subject)
  context.emitEvent?.({
    type: 'system', subtype: 'task_started', task_id: job.id, description: subject, task_type: 'shell',
    prompt: task.command, session_id: context.sessionId || '',
  })
  return {
    type: 'tool_result',
    tool_use_id: '',
    content: `${automatic ? 'Command exceeded the 15s foreground budget and was moved' : 'Background process started'}: ${job.id}\nUse ProcessOutput or TaskOutput to inspect progress.`,
    _meta: { execution: runningExecution(task.command, task.outputFile), task: { id: job.id, status: 'running', kind: 'shell', autoBackgrounded: automatic } },
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

function runningExecution(command: string, outputFile: string): ToolExecutionMetadata {
  return {
    version: 1, durationMs: 0, command: redactSensitiveText(command), terminationReason: 'running',
    resultRef: { kind: 'file', path: outputFile, size: 0, mimeType: 'text/plain' },
  }
}

async function createExecutionMetadata(input: {
  command: string; purpose?: string; outputFile: string; outputBytes: number; stdoutPreview: string; stderrPreview: string
  code: number | null; startedAt: number; terminationReason: ToolExecutionMetadata['terminationReason']
}): Promise<ToolExecutionMetadata> {
  let size = input.outputBytes
  try { size = (await stat(input.outputFile)).size } catch { /* keep captured byte count */ }
  return {
    version: 1, exitCode: input.code, stdoutPreview: boundedPreview(input.stdoutPreview), stderrPreview: boundedPreview(input.stderrPreview),
    ...(input.terminationReason === 'timeout' ? { timedOut: true } : {}),
    ...(input.terminationReason === 'aborted' ? { aborted: true } : {}),
    ...(input.terminationReason === 'output_limit' ? { outputLimitReached: true } : {}),
    durationMs: Date.now() - input.startedAt, command: redactSensitiveText(input.command),
    ...(input.purpose ? { purpose: input.purpose } : {}), terminationReason: input.terminationReason,
    resultRef: { kind: 'file', path: input.outputFile, size, mimeType: 'text/plain' },
  }
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

function interpretShellExit(command: string, exitCode: number): { isError: boolean; message: string } {
  const lastCommand = command.split(/\r?\n|&&|\|\||[|;&]/).map((part) => part.trim()).filter(Boolean).pop() || command.trim()
  const executable = lastCommand.match(/^(?:['"]([^'"]+)['"]|(\S+))/)?.slice(1).find(Boolean) || ''
  const name = executable.split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
  if (exitCode === 1 && (name === 'grep' || name === 'rg' || name === 'findstr')) return { isError: false, message: 'No matches found' }
  if (exitCode === 1 && (name === 'diff' || name === 'test' || name === '[')) return { isError: false, message: name === 'diff' ? 'Files differ' : 'Condition is false' }
  return { isError: exitCode !== 0, message: `Exit code: ${exitCode}` }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
