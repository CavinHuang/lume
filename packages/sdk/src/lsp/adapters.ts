import { resolve } from 'node:path'
import type { LspDiagnosticBatch, ToolContext } from '../types.js'
import { findLspWorkspaceRoot, resolveLspExecutable } from './registry.js'

export async function collectLspAdapterDiagnostics(
  filePath: string,
  context: ToolContext,
): Promise<{ server: string; diagnostics: LspDiagnosticBatch } | undefined> {
  if (!filePath.toLowerCase().endsWith('.swift') || !context.executeNestedTool) return undefined
  const configured = swiftLintConfig(context)
  if (configured.disabled) return undefined
  const rootMarkers = configured.rootMarkers ?? [
    '.swiftlint.yml',
    '.swiftlint.yaml',
    'Package.swift',
    '*.xcodeproj',
  ]
  const root = await findLspWorkspaceRoot(context.cwd, filePath, rootMarkers)
  if (!root) return undefined
  const command = await resolveLspExecutable(configured.command ?? 'swiftlint', root, configured.cwd)
  if (!command) return undefined
  const result = await context.executeNestedTool({
    toolName: 'Bash',
    params: {
      command: `${process.platform === 'win32' ? '& ' : ''}${quote(command)} lint --path ${quote(resolve(filePath))} --quiet --reporter json`,
      purpose: 'lsp-diagnostics',
      description: 'SwiftLint diagnostics',
    },
  })
  const output = toolOutput(result)
  return parseSwiftLintDiagnostics(output)
}

function swiftLintConfig(context: ToolContext): {
  disabled: boolean
  command?: string
  cwd?: string
  rootMarkers?: string[]
} {
  const lsp = context.toolConfig?.lsp
  if (!lsp || typeof lsp !== 'object' || Array.isArray(lsp)) return { disabled: false }
  const servers = (lsp as Record<string, unknown>).servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { disabled: false }
  const value = (servers as Record<string, unknown>).swiftlint
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { disabled: false }
  const record = value as Record<string, unknown>
  return {
    disabled: record.disabled === true,
    ...(typeof record.command === 'string' ? { command: record.command } : {}),
    ...(typeof record.cwd === 'string' ? { cwd: resolve(context.cwd, record.cwd) } : {}),
    ...(Array.isArray(record.rootMarkers)
      ? { rootMarkers: record.rootMarkers.filter((marker): marker is string => typeof marker === 'string') }
      : {}),
  }
}

export function parseSwiftLintDiagnostics(
  output: string,
): { server: string; diagnostics: LspDiagnosticBatch } | undefined {
  let values: unknown
  try {
    values = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!Array.isArray(values)) return undefined
  const items: LspDiagnosticBatch['items'] = values.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const record = value as Record<string, unknown>
    if (typeof record.reason !== 'string') return []
    const line = Math.max(Number(record.line ?? 1) - 1, 0)
    const character = Math.max(Number(record.character ?? 1) - 1, 0)
    return [{
      server: 'swiftlint',
      source: 'swiftlint',
      severity: record.severity === 'Warning' ? 2 as const : 1 as const,
      ...(typeof record.rule_id === 'string' ? { code: record.rule_id } : {}),
      message: record.reason,
      range: {
        start: { line, character },
        end: { line, character: character + 1 },
      },
    }]
  })
  return {
    server: 'swiftlint',
    diagnostics: {
      servers: ['swiftlint'],
      total: items.length,
      errors: items.filter((item) => item.severity === 1).length,
      warnings: items.filter((item) => item.severity === 2).length,
      truncated: false,
      items,
    },
  }
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function toolOutput(result: { content?: unknown }): string {
  const execution = (result as {
    _meta?: { execution?: { stdoutPreview?: unknown } }
  })._meta?.execution
  if (typeof execution?.stdoutPreview === 'string') return execution.stdoutPreview
  if (typeof result.content === 'string') return result.content
  if (Array.isArray(result.content)) {
    return result.content.map((block) =>
      block && typeof block === 'object' && 'text' in block ? String(block.text) : ''
    ).join('')
  }
  return ''
}
