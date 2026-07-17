import { useEffect, useMemo, useRef, useState } from 'react'
import { highlightCode, highlightToTokens, type HighlightTokensResult } from '@lume/ui'
import { getSourcePreviewLanguage } from './file-preview-utils'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'

export function RightPanelSourcePreview({
  content,
  filePath,
  lineSelection,
  navigationRevision,
}: {
  content: string
  filePath: string
  lineSelection?: ThreadFileLineSelection
  navigationRevision?: number
}) {
  const language = getSourcePreviewLanguage(filePath)
  const lineRefs = useRef(new Map<number, HTMLSpanElement>())
  const [theme, setTheme] = useState(getHighlightTheme)
  const [highlighted, setHighlighted] = useState<HighlightTokensResult | null>(() => (
    highlightToTokens({ code: content, language, theme })
  ))
  const lines = useMemo(() => content.replace(/\r\n/g, '\n').split('\n'), [content])
  const backgroundColor = highlighted?.bgColor ?? 'var(--surface-2)'
  const gutterWidth = `${Math.max(3, String(lines.length).length + 1)}ch`
  const selectionOutOfRange = Boolean(lineSelection && lineSelection.end > lines.length)

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(getHighlightTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const options = { code: content, language, theme }
    const syncResult = highlightToTokens(options)
    if (syncResult) {
      setHighlighted(syncResult)
      return
    }

    setHighlighted(null)
    void highlightCode(options)
      .then(() => {
        if (!cancelled) setHighlighted(highlightToTokens(options))
      })
      .catch((error) => console.error('[RightPanelSourcePreview] 高亮失败:', error))
    return () => { cancelled = true }
  }, [content, language, theme])

  useEffect(() => {
    if (!lineSelection || !highlighted || selectionOutOfRange) return
    lineRefs.current.get(lineSelection.start)?.scrollIntoView({ block: 'center' })
  }, [content, highlighted, lineSelection?.start, lineSelection?.end, navigationRevision, selectionOutOfRange])

  return (
    <div className="min-h-full min-w-full">
    {selectionOutOfRange && (
      <p role="status" className="m-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
        无法定位 L{lineSelection!.start}{lineSelection!.end === lineSelection!.start ? '' : `–L${lineSelection!.end}`}：当前可读内容只有 {lines.length} 行。
      </p>
    )}
    <pre
      className="m-0 min-h-full min-w-full w-max py-2 font-mono text-[12px] leading-5"
      style={{
        backgroundColor,
        color: highlighted?.fgColor ?? 'var(--text-1)',
        tabSize: 2,
      }}
    >
      <code>
        {lines.map((line, lineIndex) => (
          <span
            key={lineIndex}
            ref={(element) => {
              if (element) lineRefs.current.set(lineIndex + 1, element)
              else lineRefs.current.delete(lineIndex + 1)
            }}
            data-line-number={lineIndex + 1}
            className="flex min-h-5"
            style={lineSelection && !selectionOutOfRange && lineIndex + 1 >= lineSelection.start && lineIndex + 1 <= lineSelection.end
              ? { backgroundColor: 'color-mix(in oklab, var(--lume-accent) 14%, transparent)' }
              : undefined}
          >
            <span
              aria-hidden
              className="sticky left-0 shrink-0 select-none border-r border-current/10 pr-1.5 text-right opacity-35"
              style={{ width: gutterWidth, backgroundColor }}
            >
              {lineIndex + 1}
            </span>
            <span className="min-w-max pl-2 pr-3">
              {(highlighted?.lines[lineIndex] ?? []).length > 0
                ? highlighted!.lines[lineIndex]!.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
                  ))
                : line}
            </span>
          </span>
        ))}
      </code>
    </pre>
    </div>
  )
}

function getHighlightTheme(): 'github-light' | 'github-dark' {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'github-dark'
    : 'github-light'
}
