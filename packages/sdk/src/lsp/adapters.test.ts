import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { collectLspAdapterDiagnostics, parseSwiftLintDiagnostics } from './adapters.js'
import { resolveShellInvocation, shellKind } from '../utils/shell-invocation.js'

describe('SwiftLint LSP adapter', () => {
  test('normalizes JSON diagnostics to LSP positions and severities', () => {
    const result = parseSwiftLintDiagnostics(JSON.stringify([
      {
        line: 3,
        character: 5,
        severity: 'Warning',
        rule_id: 'line_length',
        reason: 'Line should be shorter.',
      },
      {
        line: 1,
        character: 1,
        severity: 'Error',
        reason: 'Invalid declaration.',
      },
    ]))

    expect(result?.diagnostics).toMatchObject({
      total: 2,
      errors: 1,
      warnings: 1,
      items: [
        {
          severity: 2,
          code: 'line_length',
          range: { start: { line: 2, character: 4 } },
        },
        {
          severity: 1,
          range: { start: { line: 0, character: 0 } },
        },
      ],
    })
  })

  test('degrades cleanly for malformed CLI output', () => {
    expect(parseSwiftLintDiagnostics('swiftlint: unknown output')).toBeUndefined()
    expect(parseSwiftLintDiagnostics('{}')).toBeUndefined()
  })

  test('shellKind classifies resolved shell executables (#328)', () => {
    expect(shellKind('powershell.exe')).toBe('powershell')
    expect(shellKind('C:\\Windows\\System32\\WindowsPowerShell\\1.0\\powershell.exe')).toBe('powershell')
    expect(shellKind('/usr/bin/pwsh')).toBe('powershell')
    expect(shellKind('bash.exe')).toBe('bash')
    expect(shellKind('/usr/bin/bash')).toBe('bash')
    expect(shellKind('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
    expect(shellKind('sh')).toBe('bash')
  })

  test('picks the PowerShell call operator from the resolved shell, not the platform (#328)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-lsp-adapter-'))
    try {
      await writeFile(join(root, '.swiftlint.yml'), '')
      const swiftlint = join(root, process.platform === 'win32' ? 'swiftlint.cmd' : 'swiftlint')
      await writeFile(swiftlint, '')
      // resolveLspExecutable requires the exec bit on POSIX; without it the
      // adapter silently finds no swiftlint and returns undefined.
      if (process.platform !== 'win32') await chmod(swiftlint, 0o755)

      let captured: string | undefined
      const context = {
        cwd: root,
        // Pin the executable explicitly so resolution never falls through to
        // a real swiftlint installed on the machine's PATH.
        toolConfig: { lsp: { servers: { swiftlint: { command: swiftlint } } } },
        executeNestedTool: async (invocation: { params: { command: string } }) => {
          captured = invocation.params.command
          return { content: '[]' }
        },
      }
      const filePath = join(root, 'Sources', 'Demo.swift')
      const result = await collectLspAdapterDiagnostics(filePath, context as any)

      expect(result).toBeDefined()
      expect(captured).toBeDefined()
      const command = captured!
      const withoutOperator = command.replace(/^& /, '')
      expect(withoutOperator).toBe(`${swiftlint} lint --path ${resolve(filePath)} --quiet --reporter json`)
      // The operator decision must match exactly what the Bash tool will
      // resolve for this command line: PowerShell dialect gets '& ', Git Bash
      // must not (a leading '&' is a syntax error there).
      const expectedPowerShell = shellKind(resolveShellInvocation(withoutOperator).command) === 'powershell'
      expect(command.startsWith('& ')).toBe(expectedPowerShell)
      if (process.platform !== 'win32') {
        expect(command.startsWith('& ')).toBe(false)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
