import { Button } from '@/components/ui/button'
/**
 * HighlightedCode - 工具结果渲染器用的代码高亮组件
 *
 * 基于 @lume/ui 的 Shiki 高亮服务，提供语法高亮和复制按钮。
 * 比 CodeBlock 更轻量，直接接收 code + language 而非 react-markdown children。
 */

import * as React from 'react'
import { highlightCode, highlightToTokens } from '@lume/ui'
import type { HighlightToken, HighlightTokensResult } from '@lume/ui'
import { cn } from '@/lib/utils'
import { Check, Copy } from 'lucide-react'
import { writeClipboardText } from '@/lib/desktop-api'

interface HighlightedCodeProps {
  code: string
  language?: string
  /** 最大显示行数，超出折叠 */
  maxLines?: number
  /** 是否显示行号 */
  showLineNumbers?: boolean
  /** 自定义 className */
  className?: string
}

const THROTTLE_MS = 80

const CodeLine = React.memo(function CodeLine({ tokens, rawLine }: { tokens: HighlightToken[]; rawLine: string }) {
  const tokenLen = tokens.reduce((sum, t) => sum + t.content.length, 0)
  return (
    <span className="line">
      {tokens.map((token, i) => (
        <span key={i} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
      ))}
      {tokenLen < rawLine.length && <span>{rawLine.slice(tokenLen)}</span>}
    </span>
  )
})

export function HighlightedCode({
  code,
  language = 'text',
  maxLines,
  showLineNumbers = false,
  className,
}: HighlightedCodeProps) {
  const [copied, setCopied] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)

  const trimmedCode = code.replace(/\n$/, '')
  const rawLines = React.useMemo(() => trimmedCode.split('\n'), [trimmedCode])
  const needsTruncation = maxLines !== undefined && rawLines.length > maxLines && !expanded
  const displayLines = needsTruncation ? rawLines.slice(0, maxLines) : rawLines

  // Shiki token 高亮
  const [tokenResult, setTokenResult] = React.useState<HighlightTokensResult | null>(
    () => highlightToTokens({ code: trimmedCode, language })
  )
  const pendingCodeRef = React.useRef(trimmedCode)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastUpdateRef = React.useRef(Date.now())

  pendingCodeRef.current = trimmedCode

  React.useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastUpdateRef.current

    const doHighlight = () => {
      const result = highlightToTokens({ code: pendingCodeRef.current, language })
      if (result) {
        lastUpdateRef.current = Date.now()
        setTokenResult(result)
      }
    }

    const syncResult = highlightToTokens({ code: trimmedCode, language })
    if (syncResult) {
      if (elapsed >= THROTTLE_MS) {
        lastUpdateRef.current = now
        setTokenResult(syncResult)
      } else if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          doHighlight()
        }, THROTTLE_MS - elapsed)
      }
      return
    }

    let cancelled = false
    highlightCode({ code: trimmedCode, language })
      .then(() => { if (!cancelled) doHighlight() })
      .catch((err) => console.error('[HighlightedCode] 高亮失败:', err))

    return () => { cancelled = true }
  }, [trimmedCode, language])

  React.useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  const handleCopy = React.useCallback(async () => {
    try {
      await writeClipboardText(trimmedCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('[HighlightedCode] 复制失败:', err)
    }
  }, [trimmedCode])

  return (
    <div className={cn('rounded-lg overflow-hidden border border-border/40 group/code', className)}>
      {/* 头部：复制按钮 */}
      <div className="flex items-center justify-end h-[28px] px-2 bg-muted/40">
        <Button
                variant="ghost"
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </Button>
      </div>

      {/* 代码区域 */}
      <pre
        className="overflow-x-auto p-3 m-0 text-ui leading-[1.8]"
        style={{
          backgroundColor: tokenResult?.bgColor ?? '#24292e',
          color: tokenResult?.fgColor ?? '#e1e4e8',
        }}
      >
        <code>
          {displayLines.map((rawLine, i) => (
            <React.Fragment key={i}>
              {i > 0 && '\n'}
              {showLineNumbers && (
                <span className="inline-block w-8 text-right mr-3 select-none opacity-40">{i + 1}</span>
              )}
              <CodeLine
                tokens={tokenResult?.lines[i] ?? []}
                rawLine={rawLine}
              />
            </React.Fragment>
          ))}
        </code>
      </pre>

      {/* 折叠提示 */}
      {needsTruncation && (
        <Button
                variant="ghost"
          onClick={() => setExpanded(true)}
          className="w-full py-1.5 text-[11px] text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 transition-colors text-center"
        >
          显示剩余 {rawLines.length - maxLines!} 行
        </Button>
      )}
    </div>
  )
}
