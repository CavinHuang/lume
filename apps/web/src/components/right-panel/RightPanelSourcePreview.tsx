import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { highlightCode, highlightToTokens, type HighlightTokensResult } from '@lume/ui'
import { getSourcePreviewLanguage } from './file-preview-utils'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'

const MAX_HIGHLIGHT_CACHE_BYTES = 24 * 1024 * 1024
const highlightCache = new Map<string, { result: HighlightTokensResult; size: number }>()
const highlightThemeListeners = new Set<() => void>()
let highlightCacheBytes = 0
let highlightThemeObserver: MutationObserver | null = null

function highlightCacheKey(content: string, language: string, theme: string): string {
  return `${theme}\u0000${language}\u0000${content}`
}

function readHighlightCache(key: string): HighlightTokensResult | null {
  const cached = highlightCache.get(key)
  if (!cached) return null
  highlightCache.delete(key)
  highlightCache.set(key, cached)
  return cached.result
}

function writeHighlightCache(key: string, content: string, result: HighlightTokensResult): void {
  const size = content.length * 6
  if (size > MAX_HIGHLIGHT_CACHE_BYTES) return
  const previous = highlightCache.get(key)
  if (previous) highlightCacheBytes -= previous.size
  highlightCache.delete(key)
  highlightCache.set(key, { result, size })
  highlightCacheBytes += size
  while (highlightCacheBytes > MAX_HIGHLIGHT_CACHE_BYTES) {
    const oldestKey = highlightCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    const oldest = highlightCache.get(oldestKey)
    highlightCache.delete(oldestKey)
    highlightCacheBytes -= oldest?.size ?? 0
  }
}

function subscribeHighlightTheme(listener: () => void): () => void {
  highlightThemeListeners.add(listener)
  if (!highlightThemeObserver && typeof MutationObserver !== 'undefined') {
    highlightThemeObserver = new MutationObserver(() => {
      for (const notify of highlightThemeListeners) notify()
    })
    highlightThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
  return () => {
    highlightThemeListeners.delete(listener)
    if (highlightThemeListeners.size === 0) {
      highlightThemeObserver?.disconnect()
      highlightThemeObserver = null
    }
  }
}

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
  const lineRefs = useRef(new Map<number, HTMLSpanElement>())
  const { highlighted, lines } = useSourceHighlight(content, filePath)
  const backgroundColor = highlighted?.bgColor ?? 'var(--surface-2)'
  const gutterWidth = `${Math.max(3, String(lines.length).length + 1)}ch`
  const selectionOutOfRange = Boolean(lineSelection && lineSelection.end > lines.length)

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

export function useSourceHighlight(content: string, filePath: string, options: {
  defer?: boolean
  enabled?: boolean
  maxCharacters?: number
} = {}): {
  highlighted: HighlightTokensResult | null
  lines: string[]
} {
  const language = getSourcePreviewLanguage(filePath)
  const theme = useSyncExternalStore(subscribeHighlightTheme, getHighlightTheme, getHighlightTheme)
  const canHighlight = options.enabled !== false && content.length <= (options.maxCharacters ?? Number.POSITIVE_INFINITY)
  const cacheKey = useMemo(() => highlightCacheKey(content, language, theme), [content, language, theme])
  const [highlighted, setHighlighted] = useState<HighlightTokensResult | null>(() => {
    if (options.defer || !canHighlight) return null
    const cached = readHighlightCache(cacheKey)
    if (cached) return cached
    const result = highlightToTokens({ code: content, language, theme })
    if (result) writeHighlightCache(cacheKey, content, result)
    return result
  })
  const completedKeyRef = useRef(highlighted ? cacheKey : '')
  const lines = useMemo(() => content.replace(/\r\n/g, '\n').split('\n'), [content])

  useEffect(() => {
    let cancelled = false
    let idleId: number | undefined
    let timerId: number | undefined
    if (!canHighlight) {
      completedKeyRef.current = ''
      setHighlighted(null)
      return
    }

    if (completedKeyRef.current === cacheKey) return
    const cached = readHighlightCache(cacheKey)
    if (cached) {
      completedKeyRef.current = cacheKey
      setHighlighted(cached)
      return
    }

    setHighlighted(null)
    const highlightOptions = { code: content, language, theme }
    const commit = (result: HighlightTokensResult | null) => {
      if (!result || cancelled) return
      writeHighlightCache(cacheKey, content, result)
      completedKeyRef.current = cacheKey
      setHighlighted(result)
    }
    const runHighlight = () => {
      const syncResult = highlightToTokens(highlightOptions)
      if (syncResult) {
        commit(syncResult)
        return
      }
      void highlightCode(highlightOptions)
        .then(() => commit(highlightToTokens(highlightOptions)))
        .catch((error) => console.error('[RightPanelSourcePreview] 高亮失败:', error))
    }

    if (options.defer && typeof window !== 'undefined') {
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(runHighlight)
      } else {
        timerId = window.setTimeout(runHighlight, 0)
      }
    } else {
      runHighlight()
    }

    return () => {
      cancelled = true
      if (idleId !== undefined) window.cancelIdleCallback(idleId)
      if (timerId !== undefined) window.clearTimeout(timerId)
    }
  }, [cacheKey, canHighlight, content, language, options.defer, theme])

  return { highlighted, lines }
}

function getHighlightTheme(): 'github-light' | 'github-dark' {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'github-dark'
    : 'github-light'
}
