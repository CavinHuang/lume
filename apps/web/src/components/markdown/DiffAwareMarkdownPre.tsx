import { useMemo, type HTMLAttributes, type ReactNode } from 'react'
import { CodeBlock } from '@lume/ui'
import { AlertTriangle, Copy } from 'lucide-react'
import { createPierreFileDiff, PierreDiffView } from '@/components/diff/PierreDiffView'
import { normalizeDiffSnippet } from '@/components/diff/diff-normalize'
import { Button } from '@/components/ui/button'
import { writeClipboardText } from '@/lib/desktop-api'

export interface DiffAwareMarkdownPreProps extends HTMLAttributes<HTMLPreElement> {
  children?: ReactNode
  domNode?: unknown
  streamStatus?: unknown
}

type CodeNodeProps = {
  className?: string
  class?: string
  lang?: string
  children?: ReactNode
}

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return textFromNode((node as { props: CodeNodeProps }).props.children)
  }
  return ''
}

function codeInfo(children: ReactNode): { language: string; source: string } {
  const element = Array.isArray(children)
    ? children.find((child) => child && typeof child === 'object' && 'props' in child)
    : children && typeof children === 'object' && 'props' in children
      ? children
      : undefined
  const props = element ? (element as { props: CodeNodeProps }).props : undefined
  const classes = [props?.className, props?.class].filter(Boolean).join(' ')
  const language = props?.lang ?? classes.match(/(?:language|lang)-([^\s]+)/)?.[1] ?? ''
  return { language: language.toLowerCase(), source: textFromNode(props?.children ?? children).replace(/\n$/, '') }
}

export function isDiffFenceLanguage(language: string): boolean {
  return language === 'diff' || language === 'patch' || language === 'udiff'
}

export function DiffAwareMarkdownPre({
  children,
  streamStatus,
}: DiffAwareMarkdownPreProps) {
  const { language, source } = useMemo(() => codeInfo(children), [children])
  const parsed = useMemo(() => {
    if (!isDiffFenceLanguage(language)) return null
    try {
      const patch = normalizeDiffSnippet(source)
      createPierreFileDiff({ patch })
      return { patch, error: null }
    } catch (error) {
      return { patch: null, error: error instanceof Error ? error.message : 'Diff 解析失败' }
    }
  }, [language, source])

  if (!parsed) return <CodeBlock onCopy={writeClipboardText}>{children}</CodeBlock>
  if (parsed.patch) {
    return (
      <div className="my-2 overflow-hidden rounded-lg border border-[var(--lume-border-subtle)]">
        <PierreDiffView patch={parsed.patch} compact className="max-h-[32rem]" />
      </div>
    )
  }
  if (streamStatus === 'loading') {
    return (
      <div className="my-2 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-app)] px-3 py-4 text-xs text-[var(--lume-text-muted)]">
        正在接收 Diff…
      </div>
    )
  }
  return (
    <div className="my-2 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <AlertTriangle size={14} />
      <span className="min-w-0 flex-1">{parsed.error}</span>
      <Button type="button" variant="ghost" size="xs" onClick={() => void writeClipboardText(source)}>
        <Copy size={12} />
        复制原文
      </Button>
    </div>
  )
}

export const DIFF_AWARE_MARKDOWN_COMPONENTS = {
  pre: DiffAwareMarkdownPre,
}
