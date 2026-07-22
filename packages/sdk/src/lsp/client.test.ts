import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTextEdits, encodeLspMessage, languageIdForPath, parseLspMessages, resolveLspServerConfigsForFile } from './client.js'

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

  test('maps TypeScript source extensions to LSP language ids', () => {
    expect(languageIdForPath('src/App.tsx')).toBe('typescriptreact')
    expect(languageIdForPath('src/index.ts')).toBe('typescript')
    expect(languageIdForPath('src/index.js')).toBe('javascript')
  })

  test('selects all matching project servers and respects root markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-config-'))
    try {
      await writeFile(join(root, 'package.json'), '{}')
      await writeFile(join(root, 'lsp.json'), JSON.stringify({ servers: {
        ts: { command: 'typescript-language-server', fileTypes: ['.ts'], rootMarkers: ['package.json'] },
        eslint: { command: 'eslint-language-server', fileTypes: ['ts'] },
        python: { command: 'pyright-langserver', fileTypes: ['.py'] },
      }}))
      const servers = await resolveLspServerConfigsForFile(root, undefined, join(root, 'src.ts'))
      expect(servers.map((server) => server.name)).toEqual(['ts', 'eslint'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})
