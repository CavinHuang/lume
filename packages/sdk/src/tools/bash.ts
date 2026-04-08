/**
 * BashTool - Execute shell commands
 */

import { spawn } from 'child_process'
import { appendFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTaskRecord, updateTaskRecord } from './task-tools.js'
import { defineTool } from './types.js'

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
      const outputFile = join(tmpdir(), `open-agent-sdk-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
      const task = createTaskRecord({
        subject: input.description || `Background shell command`,
        description: command,
        status: 'running',
        outputFile,
        taskType: 'shell',
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

      const proc = spawn('bash', ['-c', command], {
        cwd: context.cwd,
        env: { ...process.env },
        timeout: timeoutMs,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      void writeFile(outputFile, '', 'utf-8')
      const startedAt = Date.now()
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
          content: text.slice(0, 4000),
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
          content: text.slice(0, 4000),
          session_id: context.sessionId || '',
        })
      })

      proc.on('close', (code) => {
        clearInterval(progressTimer)
        const stdout = Buffer.concat(chunks).toString('utf-8')
        const stderr = Buffer.concat(errChunks).toString('utf-8')
        const output = [stdout, stderr].filter(Boolean).join('\n').trim() || '(no output)'
        updateTaskRecord(task.id, {
          status: code === 0 ? 'completed' : 'failed',
          output,
        })
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
          summary: code === 0 ? 'Task completed' : 'Task failed',
          session_id: context.sessionId || '',
        })
        context.emitEvent?.({
          type: 'system',
          subtype: 'task_notification',
          task_id: task.id,
          status: code === 0 ? 'completed' : 'failed',
          output_file: outputFile,
          summary: task.subject,
          session_id: context.sessionId || '',
        })
      })

      proc.unref()

      return {
        data: `Background task started: ${task.id}\nUse TaskOutput to inspect progress.`,
      }
    }

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []

      const proc = spawn('bash', ['-c', command], {
        cwd: context.cwd,
        env: { ...process.env },
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      proc.stdout?.on('data', (data: Buffer) => {
        chunks.push(data)
        context.emitEvent?.({
          type: 'system',
          subtype: 'local_command_output',
          content: data.toString('utf-8').slice(0, 4000),
          session_id: context.sessionId || '',
        })
      })
      proc.stderr?.on('data', (data: Buffer) => {
        errChunks.push(data)
        context.emitEvent?.({
          type: 'system',
          subtype: 'local_command_output',
          content: data.toString('utf-8').slice(0, 4000),
          session_id: context.sessionId || '',
        })
      })

      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', () => {
          proc.kill('SIGTERM')
        }, { once: true })
      }

      proc.on('close', (code) => {
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

        resolve(output || '(no output)')
      })

      proc.on('error', (err) => {
        resolve(`Error executing command: ${err.message}`)
      })
    })
  },
})
