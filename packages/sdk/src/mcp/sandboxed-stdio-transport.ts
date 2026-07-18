import { PassThrough, type Stream } from 'node:stream'
import type { ChildProcess, IOType } from 'node:child_process'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { SandboxSettings } from '../types.js'
import { spawnWithProcessSandbox } from '../utils/process-sandbox.js'

export interface SandboxedStdioServerParameters {
  command: string
  args?: string[]
  env?: Record<string, string>
  stderr?: IOType | Stream | number
  cwd?: string
  sandbox: SandboxSettings
}

export class SandboxedStdioClientTransport implements Transport {
  private child?: ChildProcess
  private readonly readBuffer = new ReadBuffer()
  private readonly stderrStream: PassThrough | null
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  constructor(private readonly server: SandboxedStdioServerParameters) {
    this.stderrStream = server.stderr === 'pipe' || server.stderr === 'overlapped'
      ? new PassThrough()
      : null
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('SandboxedStdioClientTransport already started')
    const cwd = this.server.cwd ?? process.cwd()
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawnWithProcessSandbox(this.server.command, this.server.args ?? [], {
          cwd,
          env: { ...getDefaultEnvironment(), ...this.server.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        }, this.server.sandbox)
      } catch (error) {
        reject(error)
        return
      }
      this.child = child
      child.once('error', (error) => {
        reject(error)
        this.onerror?.(error)
      })
      child.once('spawn', resolve)
      child.once('close', () => {
        if (this.child === child) this.child = undefined
        this.onclose?.()
      })
      child.stdin?.on('error', (error) => this.onerror?.(error))
      child.stdout?.on('data', (chunk: Buffer) => {
        this.readBuffer.append(chunk)
        this.processReadBuffer()
      })
      child.stdout?.on('error', (error) => this.onerror?.(error))
      if (this.stderrStream && child.stderr) {
        child.stderr.pipe(this.stderrStream)
      } else if ((this.server.stderr === undefined || this.server.stderr === 'inherit') && child.stderr) {
        child.stderr.pipe(process.stderr)
      }
    })
  }

  get stderr(): Stream | null {
    return this.stderrStream ?? this.child?.stderr ?? null
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (child) {
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      child.stdin?.end()
      await Promise.race([closed, delay(2_000)])
      if (child.exitCode === null) child.kill('SIGTERM')
      await Promise.race([closed, delay(2_000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    this.readBuffer.clear()
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin
    if (!stdin) throw new Error('Not connected')
    const payload = serializeMessage(message)
    if (stdin.write(payload)) return
    await new Promise<void>((resolve) => stdin.once('drain', resolve))
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage()
        if (message === null) return
        this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds).unref())
}
