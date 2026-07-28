import { useEffect, useMemo, useState } from 'react'
import { highlightCode, highlightToTokens } from '@lume/ui'
import type { HighlightToken, HighlightTokensResult } from '@lume/ui'
import { inferCodeLanguageFromPath } from '../code-language'

interface Props { input: Record<string, unknown>; result: unknown }

type DiffLine = {
  type: 'context' | 'added' | 'removed'
  oldLine?: number
  newLine?: number
  text: string
}

type HighlightTheme = 'github-light' | 'github-dark'

export function EditResult({ input, result }: Props) {
  const filePath = String(input.file_path ?? '')
  const oldString = String(input.old_string ?? '')
  const newString = String(input.new_string ?? '')
  const patch = (result as Record<string, unknown>)?.patch
  const lines = typeof patch === 'string' && patch.length > 0
    ? parsePatchLines(patch)
    : createEditDiffLines(oldString, newString)
  const addedLines = lines.filter((line) => line.type === 'added').length
  const removedLines = lines.filter((line) => line.type === 'removed').length

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-app)]">
      <div className="flex items-center gap-3 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--lume-text-secondary)]">{filePath}</span>
        <span className="shrink-0 tabular-nums text-[var(--lume-success)]">+{addedLines}</span>
        <span className="shrink-0 tabular-nums text-[var(--lume-danger)]">-{removedLines}</span>
      </div>
      {lines.length > 0 ? <UnifiedEditDiff lines={lines} path={filePath} /> : <div className="px-3 py-4 text-xs text-[var(--lume-text-muted)]">没有可显示的文件变更</div>}
    </div>
  )
}

function UnifiedEditDiff({ lines, path }: { lines: DiffLine[]; path: string }) {
  const [theme, setTheme] = useState<HighlightTheme>(getHighlightTheme)
  const language = useMemo(() => inferCodeLanguageFromPath(path), [path])
  const displayLines = useMemo(() => removeCommonIndent(lines), [lines])
  const code = useMemo(() => displayLines.map((line) => line.text).join('\n'), [displayLines])
  const [highlighted, setHighlighted] = useState<HighlightTokensResult | null>(
    () => highlightToTokens({ code, language, theme }),
  )

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(getHighlightTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const syncResult = highlightToTokens({ code, language, theme })
    if (syncResult) setHighlighted(syncResult)
    if (syncResult && (language === 'text' || syncResult.language !== 'text')) return

    let cancelled = false
    highlightCode({ code, language, theme })
      .then(() => {
        if (!cancelled) setHighlighted(highlightToTokens({ code, language, theme }))
      })
      .catch((error) => console.error('[EditResult] 代码高亮失败:', error))
    return () => { cancelled = true }
  }, [code, language, theme])

  return (
    <pre className="m-0 overflow-x-auto overflow-y-hidden p-0 font-mono text-[12px] leading-5">
      <code>
        {displayLines.map((line, index) => (
          <div
            key={`${line.type}-${line.oldLine ?? ''}-${line.newLine ?? ''}-${index}`}
            className={lineClassName(line.type)}
          >
            <span className={lineNumberClassName(line.type)}>
              {line.type === 'removed' ? line.oldLine ?? '' : line.newLine ?? line.oldLine ?? ''}
            </span>
            <EditSyntaxLine line={line} tokens={highlighted?.lines[index] ?? []} />
          </div>
        ))}
      </code>
    </pre>
  )
}

function removeCommonIndent(lines: DiffLine[]): DiffLine[] {
  const commonIndent = lines.reduce((minimum, line) => {
    if (line.text.trim().length === 0) return minimum
    const indent = line.text.match(/^\s*/)?.[0].length ?? 0
    return Math.min(minimum, indent)
  }, Number.POSITIVE_INFINITY)
  if (!Number.isFinite(commonIndent) || commonIndent === 0) return lines
  return lines.map((line) => ({ ...line, text: line.text.slice(commonIndent) }))
}

function EditSyntaxLine({ line, tokens }: { line: DiffLine; tokens: HighlightToken[] }) {
  const tokenLength = tokens.reduce((sum, token) => sum + token.content.length, 0)

  return (
    <span className="min-w-0 whitespace-pre pl-2 pr-3">
      <span className="mr-0.5 select-none opacity-55">{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}</span>
      {tokens.map((token, index) => <span key={index} style={token.color ? { color: token.color } : undefined}>{token.content}</span>)}
      {tokenLength < line.text.length && line.text.slice(tokenLength)}
      {line.text.length === 0 && ' '}
    </span>
  )
}

function lineClassName(type: DiffLine['type']): string {
  const layout = 'grid w-max min-w-full grid-cols-[2.5rem_auto] border-l-2'
  if (type === 'added') return `${layout} border-[color:color-mix(in_oklab,var(--lume-success)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-success)_16%,var(--lume-bg-app))] text-[var(--lume-text-primary)]`
  if (type === 'removed') return `${layout} border-[color:color-mix(in_oklab,var(--lume-danger)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-danger)_16%,var(--lume-bg-app))] text-[var(--lume-text-primary)]`
  return `${layout} border-transparent text-[var(--lume-text-secondary)]`
}

function lineNumberClassName(type: DiffLine['type']): string {
  const layout = 'select-none border-r border-[var(--lume-border-subtle)] px-2 text-right tabular-nums'
  if (type === 'added') return `${layout} text-[var(--lume-success)]`
  if (type === 'removed') return `${layout} text-[var(--lume-danger)]`
  return `${layout} text-[var(--lume-text-muted)]`
}

function createEditDiffLines(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) suffix += 1

  const lines: DiffLine[] = []
  for (let index = 0; index < prefix; index += 1) lines.push({ type: 'context', oldLine: index + 1, newLine: index + 1, text: oldLines[index] ?? '' })
  for (let index = prefix; index < oldLines.length - suffix; index += 1) lines.push({ type: 'removed', oldLine: index + 1, text: oldLines[index] ?? '' })
  for (let index = prefix; index < newLines.length - suffix; index += 1) lines.push({ type: 'added', newLine: index + 1, text: newLines[index] ?? '' })
  for (let index = Math.max(prefix, oldLines.length - suffix); index < oldLines.length; index += 1) {
    const newIndex = newLines.length - oldLines.length + index
    lines.push({ type: 'context', oldLine: index + 1, newLine: newIndex + 1, text: oldLines[index] ?? '' })
  }
  return lines
}

function parsePatchLines(patch: string): DiffLine[] {
  let oldLine = 1
  let newLine = 1
  const lines: DiffLine[] = []

  for (const rawLine of patch.replace(/\r\n/g, '\n').split('\n')) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      continue
    }
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) continue
    if (rawLine.startsWith('-')) {
      lines.push({ type: 'removed', oldLine, text: rawLine.slice(1) })
      oldLine += 1
    } else if (rawLine.startsWith('+')) {
      lines.push({ type: 'added', newLine, text: rawLine.slice(1) })
      newLine += 1
    } else if (rawLine.startsWith(' ')) {
      lines.push({ type: 'context', oldLine, newLine, text: rawLine.slice(1) })
      oldLine += 1
      newLine += 1
    }
  }
  return lines
}

function splitLines(content: string): string[] {
  if (!content) return []
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function getHighlightTheme(): HighlightTheme {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'github-dark'
    : 'github-light'
}
