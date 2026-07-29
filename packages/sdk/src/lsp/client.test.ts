import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyTextEdits,
  encodeLspMessage,
  getLspClient,
  languageIdForPath,
  parseLspMessages,
  resolveLspServerConfigsForFile,
  shutdownLspClients,
} from './client.js'
import { DEFAULT_LSP_SERVERS, findLspWorkspaceRoot, resolveLspExecutable } from './registry.js'

describe('LSP protocol helpers', () => {
  test('round trips framed messages and preserves incomplete frames', () => {
    const first = encodeLspMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    const second = encodeLspMessage({ jsonrpc: '2.0', method: 'initialized' })
    const split = first.byteLength - 3
    const partial = parseLspMessages(first.subarray(0, split))
    expect(partial.messages).toEqual([])
    const parsed = parseLspMessages(Buffer.concat([first.subarray(split), second]), partial.rest)
    expect(parsed.messages).toEqual([
      { jsonrpc: '2.0', id: 1, result: { ok: true } },
      { jsonrpc: '2.0', method: 'initialized' },
    ])
    expect(parsed.rest.byteLength).toBe(0)
    expect(parseLspMessages(Buffer.concat([Buffer.from('wrapper log\r\n\r\n'), first])).messages).toEqual([
      { jsonrpc: '2.0', id: 1, result: { ok: true } },
    ])
  })

  test('applies UTF-16 line edits from bottom to top', () => {
    expect(applyTextEdits('const foo = 1\nfoo\n', [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'bar' },
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'bar' },
    ])).toBe('const bar = 1\nbar\n')
  })

  test('preserves ordered insertions and ignores duplicate server edits', () => {
    expect(applyTextEdits('x', [
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: 'A' },
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, newText: 'B' },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: 'y' },
    ])).toBe('yAB')
  })

  test('maps registry source extensions to LSP language ids', () => {
    expect(languageIdForPath('src/App.tsx')).toBe('typescriptreact')
    expect(languageIdForPath('src/index.ts')).toBe('typescript')
    expect(languageIdForPath('src/index.js')).toBe('javascript')
    expect(languageIdForPath('src/main.rs')).toBe('rust')
    expect(languageIdForPath('src/main.py')).toBe('python')
    expect(languageIdForPath('Dockerfile')).toBe('dockerfile')
    expect(languageIdForPath('infra/main.tf')).toBe('terraform')
    expect(languageIdForPath('README.md')).toBe('markdown')
  })

  test('selects all matching project servers and respects root markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-config-'))
    try {
      const tsServer = join(root, process.platform === 'win32' ? 'ts-server.cmd' : 'ts-server')
      const eslintServer = join(root, process.platform === 'win32' ? 'eslint-server.cmd' : 'eslint-server')
      await writeFile(tsServer, process.platform === 'win32' ? '@exit /b 0' : '#!/bin/sh\nexit 0\n')
      await writeFile(eslintServer, process.platform === 'win32' ? '@exit /b 0' : '#!/bin/sh\nexit 0\n')
      if (process.platform !== 'win32') {
        await chmod(tsServer, 0o755)
        await chmod(eslintServer, 0o755)
      }
      await writeFile(join(root, 'package.json'), '{}')
      await writeFile(join(root, 'lsp.json'), JSON.stringify({ servers: {
        ts: { command: tsServer, fileTypes: ['.ts'], rootMarkers: ['package.json'], priority: 10 },
        eslint: { command: eslintServer, fileTypes: ['ts'], role: 'linter' },
        python: { command: 'pyright-langserver', fileTypes: ['.py'] },
      }}))
      const servers = await resolveLspServerConfigsForFile(root, undefined, join(root, 'src.ts'))
      expect(servers.map((server) => server.name)).toEqual(['ts', 'eslint'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps direct run config and legacy environment overrides compatible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-run-config-'))
    const previousCommand = process.env.LUME_LSP_COMMAND
    const previousArgs = process.env.LUME_LSP_ARGS
    try {
      const source = join(root, 'index.ts')
      await writeFile(source, '')
      const direct = await resolveLspServerConfigsForFile(root, {
        lsp: { command: process.execPath, args: ['direct-server.mjs'] },
      }, source)
      expect(direct).toMatchObject([{
        name: 'default',
        command: process.execPath,
        args: ['direct-server.mjs'],
      }])

      process.env.LUME_LSP_COMMAND = process.execPath
      process.env.LUME_LSP_ARGS = 'legacy-server.mjs --stdio'
      const legacy = await resolveLspServerConfigsForFile(root, { lsp: { enabled: true } }, source)
      expect(legacy).toMatchObject([{
        name: 'legacy',
        command: process.execPath,
        args: ['legacy-server.mjs', '--stdio'],
      }])
    } finally {
      if (previousCommand === undefined) delete process.env.LUME_LSP_COMMAND
      else process.env.LUME_LSP_COMMAND = previousCommand
      if (previousArgs === undefined) delete process.env.LUME_LSP_ARGS
      else process.env.LUME_LSP_ARGS = previousArgs
      await rm(root, { recursive: true, force: true })
    }
  })

  test('ships the complete built-in registry and resolves project shims', async () => {
    expect(Object.keys(DEFAULT_LSP_SERVERS)).toHaveLength(53)
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-registry-'))
    try {
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
      const shim = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'demo.cmd' : 'demo')
      await writeFile(shim, process.platform === 'win32' ? '@exit /b 0' : '#!/bin/sh\nexit 0\n')
      if (process.platform !== 'win32') await chmod(shim, 0o755)
      expect(await resolveLspExecutable('demo', root)).toBe(shim)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('supports glob root markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-marker-'))
    try {
      await writeFile(join(root, 'demo.sln'), '')
      await mkdir(join(root, 'src'))
      expect(await findLspWorkspaceRoot(root, join(root, 'src', 'Program.cs'), ['*.sln'])).toBe(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('synchronizes documents, serves configuration sections and shuts down cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-client-'))
    try {
      const script = join(root, 'server.mjs')
      const source = join(root, 'index.ts')
      await writeFile(join(root, 'package.json'), '{}')
      await writeFile(source, 'const value = 1\n')
      await writeFile(script, `
let buffer = Buffer.alloc(0)
const notifications = []
let configuration
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
    if (message.id === 900 && !message.method) {
      configuration = message.result
    } else if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { diagnosticProvider: true } } })
    } else if (message.method === 'initialized') {
      send({ jsonrpc: '2.0', id: 900, method: 'workspace/configuration', params: { items: [{ section: 'typescript.preferences' }] } })
    } else if (message.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: message.id, result: null })
    } else if (message.method === 'exit') {
      process.exit(0)
    } else if (message.method === 'test/state') {
      send({ jsonrpc: '2.0', id: message.id, result: { notifications, configuration } })
    } else if (message.method === 'textDocument/diagnostic') {
      send({ jsonrpc: '2.0', id: message.id, result: { items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 2, message: 'demo' }] } })
    } else if (message.method && !('id' in message)) {
      notifications.push(message.method)
    }
  }
})
`)
      const config = {
        lsp: {
          servers: {
            test: {
              command: process.execPath,
              args: [script],
              fileTypes: ['.ts'],
              rootMarkers: ['package.json'],
              settings: { typescript: { preferences: { quoteStyle: 'single' } } },
            },
          },
        },
      }
      const client = await getLspClient(root, config, source)
      const before = client.getDiagnosticsSequence()
      const version = await client.syncContent(source, 'const value = 2\n')
      await client.notifySaved(source)
      const diagnostics = await client.waitForDiagnostics(source, 1_000, undefined, version, before)
      expect(diagnostics[0]?.message).toBe('demo')
      await new Promise((resolve) => setTimeout(resolve, 20))
      const state = await client.request<{ notifications: string[]; configuration: unknown[] }>('test/state', {})
      expect(state.notifications).toContain('textDocument/didOpen')
      expect(state.notifications).toContain('textDocument/didSave')
      expect(state.configuration).toEqual([{ quoteStyle: 'single' }])
    } finally {
      await shutdownLspClients(root)
      await rm(root, { recursive: true, force: true })
    }
  })
})
