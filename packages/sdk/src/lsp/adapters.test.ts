import { describe, expect, test } from 'bun:test'
import { parseSwiftLintDiagnostics } from './adapters.js'

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
})
