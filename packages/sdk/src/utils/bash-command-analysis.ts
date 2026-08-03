import { nativeAnalyzeBash } from '@lume/natives'

export type BashParseStatus = 'simple' | 'too-complex' | 'parse-unavailable'

export interface BashCommandSegment {
  argv: string[]
  executable: string
}

export interface BashCommandAnalysis {
  status: BashParseStatus
  commands: BashCommandSegment[]
  hasPipeline: boolean
  hasRedirection: boolean
}

/**
 * Return shell structure only when the native tree-sitter parser can prove it
 * is simple. Consumers must require confirmation for every other status.
 */
export function analyzeBashCommand(command: string): BashCommandAnalysis {
  if (/^\s*(?:powershell|pwsh)(?:\.exe)?\b/i.test(command)) {
    return { status: 'parse-unavailable', commands: [], hasPipeline: false, hasRedirection: false }
  }
  const result = nativeAnalyzeBash(command)
  if (!result) return { status: 'parse-unavailable', commands: [], hasPipeline: false, hasRedirection: false }
  const status: BashParseStatus = result.status === 'simple' || result.status === 'too-complex'
    ? result.status
    : 'parse-unavailable'
  return {
    status,
    commands: status === 'simple'
      ? result.commands.filter((segment) => segment.argv.length > 0).map((segment) => ({
          argv: segment.argv,
          executable: normalizeExecutable(segment.argv[0] ?? ''),
        }))
      : [],
    hasPipeline: Boolean(result.has_pipeline ?? result.hasPipeline),
    hasRedirection: Boolean(result.has_redirection ?? result.hasRedirection),
  }
}

export function normalizeExecutable(value: string): string {
  return value.split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase() ?? ''
}
