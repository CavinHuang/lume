/**
 * BashTool - Execute shell commands
 */

import { appendFile, mkdir, stat, writeFile } from 'fs/promises'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskRecord, registerTaskStopHandler, unregisterTaskStopHandler, updateTaskRecord } from './task-tools.js'
import { defineTool } from './types.js'
import type { ToolExecutionMetadata } from '../types.js'
import { resolveShellInvocation } from '../utils/shell-invocation.js'
import { spawnWithProcessSandbox } from '../utils/process-sandbox.js'

export const BashTool = defineTool({
  name: 'Bash',
  description: 'Execute a bash command and return its output. Use for running shell commands, scripts, and system operations.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000, default 120000)',
      },
      description: {
        type: 'string',
        description: 'Short description for background task tracking',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Run the command in the background and return a task ID immediately',
      },
      purpose: {
        type: 'string',
        description: 'Optional execution purpose, e.g. verification',
      },
    },
    required: ['command'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    const { command, timeout: userTimeout } = input
    const timeoutMs = Math.min(userTimeout || 120000, 600000)
    const commandPrefix = String(command).trim().split(/\s+/)[0]?.toLowerCase()
    const excluded = context.sandbox?.excludedCommands || []
    if (commandPrefix && excluded.some((value) => value.toLowerCase() === commandPrefix)) {
      return { data: `Sandbox blocked command prefix "${commandPrefix}"`, is_error: true }
    }

    if (input.run_in_background) {
      const outputDirectory = context.artifactsRoot ? join(context.artifactsRoot, 'tool-results') : tmpdir()
      mkdirSync(outputDirectory, { recursive: true })
      const outputFile = join(outputDirectory, `bash-${context.sessionId || 'session'}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
      const purpose = typeof input.purpose === 'string' && input.purpose.trim() ? input.purpose.trim() : undefined
      const task = createTaskRecord({
        subject: input.description || `Background shell command`,
        description: command,
        status: 'running',
        outputFile,
        taskType: 'shell',
        metadata: {
          execution: {
            version: 1,
            durationMs: 0,
            command: redactSensitiveText(String(command)),
            ...(purpose ? { purpose } : {}),
            terminationReason: 'running',
            resultRef: { kind: 'file', path: outputFile, size: 0, mimeType: 'text/plain' },
          } satisfies ToolExecutionMetadata,
        },
      })

      context.emitEvent?.({
        type: 'system',
        subtype: 'task_started',
        task_id: task.id,
        description: task.subject,
        task_type: 'shell',
        prompt: command,
        session_id: context.sessionId || '',
      })

      const shell = resolveShellInvocation(command)
      const proc = spawnWithProcessSandbox(shell.command, shell.args, {
        cwd: context.cwd,
        env: { ...process.env },
        timeoutMs,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }, context.sandbox)
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      await writeFile(outputFile, '', 'utf-8')
      const startedAt = Date.now()
      let terminationReason: ToolExecutionMetadata['terminationReason'] = 'completed'
      let settled = false
      const timeoutTimer = setTimeout(() => {
        if (!settled) {
          terminationReason = 'timeout'
          proc.kill('SIGTERM')
        }
      }, timeoutMs)
      timeoutTimer.unref?.()
      const abortHandler = () => {
        if (!settled) terminationReason = 'aborted'
        proc.kill('SIGTERM')
      }
      context.abortSignal?.addEventListener('abort', abortHandler, { once: true })
      const progressTimer = setInterval(() => {
        const current = updateTaskRecord(task.id, {
          status: 'running',
        })
        if (!current) return
        context.emitEvent?.({
          type: 'system',
          subtype: 'task_progress',
          task_id: task.id,
          description: task.subject,
          last_tool_name: 'Bash',
          usage: {
            total_tokens: 0,
            tool_uses: 1,
            duration_ms: Date.now() - startedAt,
          },
          session_id: context.sessionId || '',
        })
      }, 1000)
      progressTimer.unref?.()

      proc.stdout?.on('data', (data: Buffer) => {
        chunks.push(data)
        const text = data.toString('utf-8')
        void appendFile(outputFile, text, 'utf-8')
        context.emitEvent?.({
          type: 'system',
          subtype: 'local_command_output',
          content: boundedPreview(text, 4000),
          session_id: context.sessionId || '',
        })
      })
      proc.stderr?.on('data', (data: Buffer) => {
        errChunks.push(data)
        const text = data.toString('utf-8')
        void appendFile(outputFile, text, 'utf-8')
        context.emitEvent?.({
          type: 'system',
          subtype: 'local_command_output',
          content: boundedPreview(text, 4000),
          session_id: context.sessionId || '',
        })
      })

      const finish = async (code: number | null, errorMessage?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        context.abortSignal?.removeEventListener('abort', abortHandler)
        clearInterval(progressTimer)
        const stdout = Buffer.concat(chunks).toString('utf-8')
        const stderr = Buffer.concat(errChunks).toString('utf-8')
        if (errorMessage) errChunks.push(Buffer.from(errorMessage))
        if (terminationReason === 'completed' && code !== 0) terminationReason = 'nonzero'
        const output = boundedPreview([stdout, stderr, errorMessage].filter(Boolean).join('\n').trim() || '(no output)')
        const resultRef = await createArtifactRef(context.artifactsRoot, context.sessionId, String(command), stdout, stderr)
        const outputFileRef = await createFileResultRef(outputFile)
        const execution: ToolExecutionMetadata = {
          version: 1,
          exitCode: code,
          stdoutPreview: boundedPreview(stdout),
          stderrPreview: boundedPreview(stderr),
          ...(terminationReason === 'timeout' ? { timedOut: true } : {}),
          ...(terminationReason === 'aborted' ? { aborted: true } : {}),
          durationMs: Date.now() - startedAt,
          command: redactSensitiveText(String(command)),
          ...(purpose ? { purpose } : {}),
          terminationReason,
          resultRef: resultRef.resultRef ?? outputFileRef,
        }
        updateTaskRecord(task.id, {
          status: terminationReason === 'completed' ? 'completed' : terminationReason === 'aborted' ? 'stopped' : 'failed',
          output,
          metadata: { execution },
        })
        unregisterTaskStopHandler(task.id)
        context.emitEvent?.({
          type: 'system',
          subtype: 'task_progress',
          task_id: task.id,
          description: task.subject,
          last_tool_name: 'Bash',
          usage: {
            total_tokens: 0,
            tool_uses: 1,
            duration_ms: Date.now() - startedAt,
          },
          summary: terminationReason === 'completed' ? 'Task completed' : `Task ${terminationReason}`,
          session_id: context.sessionId || '',
        })
        context.emitEvent?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: task.id,
          status: terminationReason === 'completed' ? 'completed' : 'failed',
          output_file: outputFile,
          summary: task.subject,
          execution,
          session_id: context.sessionId || '',
        } as any)
        context.onBackgroundTaskCompleted?.()
      }

      registerTaskStopHandler(task.id, () => {
        if (!settled) terminationReason = 'aborted'
        proc.kill('SIGTERM')
      })
      proc.on('close', (code) => { void finish(code) })
      proc.on('error', (error) => { terminationReason = 'spawn_error'; void finish(null, error.message) })

      proc.unref()

      return {
        data: `Background task started: ${task.id}\nUse TaskOutput to inspect progress.`,
        _meta: {
          execution: {
            version: 1,
            durationMs: 0,
            command: redactSensitiveText(String(command)),
            ...(purpose ? { purpose } : {}),
            terminationReason: 'running',
            resultRef: { kind: 'file', path: outputFile, size: 0, mimeType: 'text/plain' },
          } satisfies ToolExecutionMetadata,
        },
      }
    }

    return new Promise<{ data: string; is_error?: boolean; _meta?: Record<string, unknown> }>((resolve) => {
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      const startedAt = Date.now()
      let terminationReason: ToolExecutionMetadata['terminationReason'] = 'completed'
      let settled = false

      const shell = resolveShellInvocation(command)
      const proc = spawnWithProcessSandbox(shell.command, shell.args, {
        cwd: context.cwd,
        env: { ...process.env },
        timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      }, context.sandbox)
      const timeoutTimer = setTimeout(() => {
        if (!settled) {
          terminationReason = 'timeout'
          proc.kill('SIGTERM')
        }
      }, timeoutMs)
      timeoutTimer.unref?.()

      proc.stdout?.on('data', (data: Buffer) => {
        chunks.push(data)
        context.emitEvent?.({
          type: 'system',
          subtype: 'local_command_output',
          content: boundedPreview(data.toString('utf-8'), 4000),
          session_id: context.sessionId || '',
        })
      })
      proc.stderr?.on('data', (data: Buffer) => {
        errChunks.push(data)
        context.emitEvent?.({
          type: 'system',
          subtype: 'local_command_output',
          content: boundedPreview(data.toString('utf-8'), 4000),
          session_id: context.sessionId || '',
        })
      })

      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', () => {
          if (!settled) terminationReason = 'aborted'
          proc.kill('SIGTERM')
        }, { once: true })
      }

      proc.on('close', async (code) => {
        clearTimeout(timeoutTimer)
        settled = true
        const stdout = Buffer.concat(chunks).toString('utf-8')
        const stderr = Buffer.concat(errChunks).toString('utf-8')

        let output = ''
        if (stdout) output += stdout
        if (stderr) output += (output ? '\n' : '') + stderr
        if (code !== 0 && code !== null) {
          output += `\nExit code: ${code}`
        }

        // Truncate very large outputs
        if (output.length > 100000) {
          output = output.slice(0, 50000) + '\n...(truncated)...\n' + output.slice(-50000)
        }

        if (terminationReason === 'completed' && code !== 0) terminationReason = 'nonzero'
        const execution: ToolExecutionMetadata = {
          version: 1,
          exitCode: code,
          stdoutPreview: boundedPreview(stdout),
          stderrPreview: boundedPreview(stderr),
          ...(terminationReason === 'timeout' ? { timedOut: true } : {}),
          ...(terminationReason === 'aborted' ? { aborted: true } : {}),
          durationMs: Date.now() - startedAt,
          command: redactSensitiveText(String(command)),
          ...(typeof input.purpose === 'string' && input.purpose.trim() ? { purpose: input.purpose.trim() } : {}),
          terminationReason,
          ...(await createArtifactRef(context.artifactsRoot, context.sessionId, String(command), stdout, stderr)),
        }
        resolve({
          data: output || '(no output)',
          ...(terminationReason !== 'completed' ? { is_error: true } : {}),
          _meta: { execution },
        })
      })

      proc.on('error', (err) => {
        clearTimeout(timeoutTimer)
        settled = true
        terminationReason = 'spawn_error'
        const execution: ToolExecutionMetadata = {
          version: 1,
          exitCode: null,
          stderrPreview: boundedPreview(err.message),
          durationMs: Date.now() - startedAt,
          command: redactSensitiveText(String(command)),
          ...(typeof input.purpose === 'string' && input.purpose.trim() ? { purpose: input.purpose.trim() } : {}),
          terminationReason,
        }
        resolve({
          data: `Error executing command: ${err.message}`,
          is_error: true,
          _meta: { execution },
        })
      })
    })
  },
})

function boundedPreview(value: string, maxChars = 4000): string {
  value = redactSensitiveText(value)
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars / 2)}\n...(truncated)...\n${value.slice(-maxChars / 2)}`
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
}

async function createArtifactRef(
  artifactsRoot: string | undefined,
  sessionId: string | undefined,
  command: string,
  stdout: string,
  stderr: string,
): Promise<{ resultRef?: ToolExecutionMetadata['resultRef'] }> {
  if (!artifactsRoot) return {}
  try {
    const root = join(artifactsRoot, 'tool-results')
    await mkdir(root, { recursive: true })
    const path = join(root, `${sessionId || 'session'}-${Date.now()}-${crypto.randomUUID()}.log`)
    await writeFile(path, [`$ ${redactSensitiveText(command)}`, redactSensitiveText(stdout), redactSensitiveText(stderr)].filter(Boolean).join('\n'), 'utf-8')
    const size = (await stat(path)).size
    return { resultRef: { kind: 'file', path, size, mimeType: 'text/plain' } }
  } catch {
    return {}
  }
}

async function createFileResultRef(path: string): Promise<NonNullable<ToolExecutionMetadata['resultRef']>> {
  try {
    const fileStat = await stat(path)
    return { kind: 'file', path, size: fileStat.size, mimeType: 'text/plain' }
  } catch {
    return { kind: 'file', path, size: 0, mimeType: 'text/plain' }
  }
}
