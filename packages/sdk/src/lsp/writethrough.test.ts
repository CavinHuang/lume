import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage, ToolContext } from '../types.js'
import { shutdownLspClients } from './client.js'
import { prepareLspWritethrough } from './writethrough.js'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('LSP write-through coordinator', () => {
  test('keeps formatting opt-in and drops diagnostics for a superseded mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-writethrough-'))
    const source = join(root, 'index.ts')
    const serverScript = join(root, 'server.mjs')
    const events: SDKMessage[] = []
    try {
      await writeFile(join(root, 'package.json'), '{}')
      await writeFile(source, 'const value=1\n')
      await writeFile(serverScript, `
let buffer = Buffer.alloc(0)
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value))
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]))
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const end = buffer.indexOf('\\r\\n\\r\\n')
    if (end < 0) return
    const match = buffer.subarray(0, end).toString().match(/Content-Length:\\s*(\\d+)/i)
    if (!match) process.exit(2)
    const length = Number(match[1])
    if (buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length))
    buffer = buffer.subarray(end + 4 + length)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentFormattingProvider: true } } })
    } else if (message.method === 'textDocument/formatting') {
      send({ jsonrpc: '2.0', id: message.id, result: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 100 } },
        newText: 'const value = 1'
      }] })
    } else if (message.method === 'textDocument/didSave') {
      const uri = message.params.textDocument.uri
      setTimeout(() => send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [{
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
            severity: 1,
            message: 'delayed diagnostic'
          }]
        }
      }), 650)
    } else if (message.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: null })
    } else if (message.method === 'exit') {
      process.exit(0)
    }
  }
})
`)
      const server = {
        command: process.execPath,
        args: [serverScript],
        fileTypes: ['.ts'],
        rootMarkers: ['package.json'],
      }
      const baseContext = {
        cwd: root,
        sessionId: 'session',
        toolUseId: 'write-1',
        emitEvent: (event: SDKMessage) => events.push(event),
      } as ToolContext

      const unformatted = await prepareLspWritethrough({
        filePath: source,
        content: 'const value=1\n',
        context: {
          ...baseContext,
          toolConfig: {
            lsp: {
              diagnosticsOnWrite: false,
              formatOnWrite: false,
              servers: { test: server },
            },
          },
        },
        existedBefore: true,
      })
      expect(unformatted.content).toBe('const value=1\n')

      const formatted = await prepareLspWritethrough({
        filePath: source,
        content: 'const value=1\n',
        context: {
          ...baseContext,
          toolConfig: {
            lsp: {
              diagnosticsOnWrite: false,
              formatOnWrite: true,
              servers: { test: server },
            },
          },
        },
        existedBefore: true,
      })
      expect(formatted.content).toBe('const value = 1\n')

      const delayed = await prepareLspWritethrough({
        filePath: source,
        content: 'const value = 2\n',
        context: {
          ...baseContext,
          toolConfig: {
            lsp: {
              diagnosticsOnWrite: true,
              formatOnWrite: false,
              servers: { test: server },
            },
          },
        },
        existedBefore: true,
      })
      await writeFile(source, delayed.content)
      const result = await delayed.commit()
      expect(result.diagnosticsDelayed).toBe(true)

      await writeFile(source, 'const value = 3\n')
      await wait(1_100)
      expect(events).toEqual([])
    } finally {
      await shutdownLspClients(root)
      await rm(root, { recursive: true, force: true })
    }
  })

  test('emits a delayed diagnostic for the current file mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-current-diagnostics-'))
    const source = join(root, 'index.ts')
    const serverScript = join(root, 'server.mjs')
    const events: SDKMessage[] = []
    try {
      await writeFile(join(root, 'package.json'), '{}')
      await writeFile(source, 'const value = 1\n')
      await writeFile(serverScript, `
let buffer = Buffer.alloc(0)
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value))
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]))
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const end = buffer.indexOf('\\r\\n\\r\\n')
    if (end < 0) return
    const length = Number(buffer.subarray(0, end).toString().match(/Content-Length:\\s*(\\d+)/i)?.[1])
    if (!length || buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length))
    buffer = buffer.subarray(end + 4 + length)
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
    } else if (message.method === 'textDocument/didSave') {
      setTimeout(() => send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: message.params.textDocument.uri,
          diagnostics: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            severity: 2,
            message: 'current diagnostic'
          }]
        }
      }), 650)
    } else if (message.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: null })
    } else if (message.method === 'exit') {
      process.exit(0)
    }
  }
})
`)
      const context = {
        cwd: root,
        sessionId: 'session',
        toolUseId: 'write-2',
        toolConfig: {
          lsp: {
            servers: {
              test: {
                command: process.execPath,
                args: [serverScript],
                fileTypes: ['.ts'],
                rootMarkers: ['package.json'],
              },
            },
          },
        },
        emitEvent: (event: SDKMessage) => events.push(event),
      } as ToolContext
      const prepared = await prepareLspWritethrough({
        filePath: source,
        content: 'const value = 2\n',
        context,
        existedBefore: true,
      })
      await writeFile(source, prepared.content)
      expect((await prepared.commit()).diagnosticsDelayed).toBe(true)
      await wait(1_100)

      expect(events).toContainEqual(expect.objectContaining({
        type: 'system',
        subtype: 'lsp_diagnostics',
        file_path: source,
        delayed: true,
        diagnostics: expect.objectContaining({
          total: 1,
          warnings: 1,
          items: [expect.objectContaining({ message: 'current diagnostic' })],
        }),
      }))
    } finally {
      await shutdownLspClients(root)
      await rm(root, { recursive: true, force: true })
    }
  })
})
