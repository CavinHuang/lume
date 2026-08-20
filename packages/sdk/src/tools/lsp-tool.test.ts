import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  LSPApplyTool,
  LSPTool,
  applyWorkspaceEdit,
  mergeRenameWorkspaceEdits,
  resolveAgentPosition,
  workspaceDiagnosticsCommand,
} from './lsp-tool.js'

describe('LSP tool boundaries', () => {
  test('keeps queries read-only and separates mutations', () => {
    expect(LSPTool.name).toBe('LSP')
    expect(LSPTool.isReadOnly?.()).toBe(true)
    expect(LSPTool.isConcurrencySafe?.()).toBe(true)
    expect(LSPApplyTool.name).toBe('LSPApply')
    expect(LSPApplyTool.isReadOnly?.()).toBe(false)
    expect(LSPApplyTool.isConcurrencySafe?.()).toBe(false)
  })

  test('resolves 1-based lines and symbol occurrence selectors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-position-'))
    const file = join(root, 'index.ts')
    try {
      await writeFile(file, 'const value = 1\nconst value2 = value\n')
      expect(await resolveAgentPosition(file, { line_number: 2 })).toEqual({ line: 1, character: 0 })
      expect(await resolveAgentPosition(file, { symbol: 'value#2' })).toEqual({ line: 1, character: 6 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('prefers primary rename edits over linter conflicts', () => {
    const merged = mergeRenameWorkspaceEdits([
      {
        server: 'linter',
        result: { changes: { 'file:///index.ts': [{
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } },
          newText: 'linter',
        }] } },
      },
      {
        server: 'primary',
        result: { changes: { 'file:///index.ts': [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          newText: 'primary',
        }] } },
      },
    ], new Map([['primary', 'primary'], ['linter', 'linter']]))

    expect(merged.changes?.['file:///index.ts']).toEqual([{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      newText: 'primary',
    }])
  })

  test('rejects overlapping edits returned by equally authoritative rename servers', () => {
    expect(() => mergeRenameWorkspaceEdits([
      {
        server: 'primary-a',
        result: { changes: { 'file:///index.ts': [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          newText: 'first',
        }] } },
      },
      {
        server: 'primary-b',
        result: { changes: { 'file:///index.ts': [{
          range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } },
          newText: 'second',
        }] } },
      },
    ])).toThrow('Conflicting')
  })

  test('defaults renameFile application to LSPApply while keeping explicit preview read-only', async () => {
    const context = { cwd: process.cwd() } as any
    const applyResult = await LSPApplyTool.call({
      operation: 'renameFile',
      file_path: 'missing.ts',
      new_path: 'renamed.ts',
    }, context)
    const wrongToolResult = await LSPTool.call({
      operation: 'renameFile',
      file_path: 'missing.ts',
      new_path: 'renamed.ts',
    }, context)
    const previewResult = await LSPTool.call({
      operation: 'renameFile',
      file_path: 'missing.ts',
      new_path: 'renamed.ts',
      apply: false,
    }, context)

    expect(String(applyResult.content)).not.toContain('LSPApply only accepts')
    expect(String(wrongToolResult.content)).toContain('use LSPApply')
    expect(String(previewResult.content)).not.toContain('use LSPApply')
  })

  test('keeps edited children inside a renamed directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-directory-rename-'))
    const oldDirectory = join(root, 'old')
    const newDirectory = join(root, 'new')
    const oldFile = join(oldDirectory, 'index.ts')
    const newFile = join(newDirectory, 'index.ts')
    try {
      await mkdir(oldDirectory)
      await writeFile(oldFile, 'export const value = 1\n')

      await applyWorkspaceEdit({
        changes: {
          [pathToFileURL(oldFile).toString()]: [{
            range: {
              start: { line: 0, character: 21 },
              end: { line: 0, character: 22 },
            },
            newText: '2',
          }],
        },
        documentChanges: [{
          kind: 'rename',
          oldUri: pathToFileURL(oldDirectory).toString(),
          newUri: pathToFileURL(newDirectory).toString(),
        }],
      }, { cwd: root } as any)

      expect(await readFile(newFile, 'utf8')).toBe('export const value = 2\n')
      expect(await stat(oldDirectory).catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('builds every module declared by a go.work fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-go-work-'))
    try {
      await writeFile(join(root, 'go.work'), [
        'go 1.22',
        'use (',
        '  ./service-a',
        '  "./service b"',
        ')',
      ].join('\n'))

      expect(await workspaceDiagnosticsCommand(root)).toBe(
        // paths with spaces are single-quoted ('' escaping), plain paths stay bare (#198)
        "go build ./service-a/... './service b/...'",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses resource operations outside workspace roots and UNC targets (#197)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-resource-guard-'))
    const outside = join(root, '..', `lume-lsp-resource-out-${Date.now()}`)
    try {
      await mkdir(outside)
      await writeFile(join(outside, 'a.ts'), 'x')

      const ctx = { cwd: root } as never

      // delete of a directory outside every root: refused
      await expect(applyWorkspaceEdit({
        documentChanges: [{ kind: 'delete', uri: pathToFileURL(outside).toString(), options: { recursive: true } }],
      }, ctx)).rejects.toThrow(/workspace roots/)

      // delete of the workspace root itself: refused (strict)
      await expect(applyWorkspaceEdit({
        documentChanges: [{ kind: 'delete', uri: pathToFileURL(root).toString(), options: { recursive: true } }],
      }, ctx)).rejects.toThrow(/workspace root/)

      // UNC paths reach the unsafe-path screening before any filesystem call
      await expect(applyWorkspaceEdit({
        documentChanges: [{ kind: 'create', uri: 'file://server/share/evil.ts' }],
      }, ctx)).rejects.toThrow()

      // the outside victim survived everything
      expect(await stat(join(outside, 'a.ts'))).toBeTruthy()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('drops go.work use entries that carry shell metacharacters (#198)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-go-work-inject-'))
    try {
      await writeFile(join(root, 'go.work'), [
        'go 1.22',
        'use (',
        '  ./api',
        '  "./x$(curl evil)"',
        '  "./y`id`"',
        ')',
      ].join('\n'))

      const command = await workspaceDiagnosticsCommand(root)
      expect(command).toBe('go build ./api/...')
      expect(command).not.toContain('$(')
      expect(command).not.toContain('`')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('routes workspace diagnostics fallback through the nested Bash tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-workspace-diagnostics-'))
    const calls: Array<{ toolName: string; params: unknown }> = []
    try {
      await writeFile(join(root, 'tsconfig.json'), '{}')
      const result = await LSPTool.call({
        operation: 'diagnostics',
        file_path: '*',
      }, {
        cwd: root,
        toolConfig: { lsp: { enabled: false } },
        async executeNestedTool(call: { toolName: string; params: unknown }) {
          calls.push(call)
          return {
            type: 'tool_result',
            tool_use_id: 'nested',
            content: 'typecheck completed',
            _meta: { execution: { version: 2, outcome: 'succeeded' } },
          } as any
        },
      } as any)

      expect(calls).toEqual([{
        toolName: 'Bash',
        params: {
          command: 'npx tsc --noEmit',
          purpose: 'verification',
          description: 'LSP workspace diagnostics fallback',
        },
      }])
      expect(String(result.content)).toContain('typecheck completed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
