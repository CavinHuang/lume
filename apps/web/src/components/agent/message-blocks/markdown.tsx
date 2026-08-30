import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type AnchorHTMLAttributes, type ClipboardEvent, type HTMLAttributes, type ReactNode } from 'react'
import { Check, ChevronDown, Copy, FileText, Maximize2, Minimize2, X } from 'lucide-react'
import { XMarkdown } from '@ant-design/x-markdown'
import { MermaidBlock, useSmoothStream } from '@lume/ui'
import { DiffAwareMarkdownPre } from '@/components/markdown/DiffAwareMarkdownPre'
import { cn } from '@/lib/utils'
import { parseAfterglowBlocks } from '@lume/shared'
import { toast } from 'sonner'
import { writeClipboardImage, writeClipboardText } from '@/lib/desktop-api'
import { parseMessageThreadFileReference } from '../thread-file-links'
import { useMessageFileReferenceBinding, useMessageFileReferenceProtocolVersion } from '../thread-file-env'
import { AgentFileReference, type OpenThreadFile } from '../AgentFileReference'
import { getMermaidCodeFromPreNode, isMermaidPreStreaming } from '../markdown-mermaid'
import { getInfographicCodeFromPreNode, isInfographicPreStreaming } from '../markdown-infographic'
import { InfographicBlock } from '../InfographicBlock'
import { mermaidSvgToPngDataUrl } from '@/lib/mermaid-image'
import type { PlanPreviewView } from '../runtime-message-view'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CopyFeedbackState, getAssistantCopyText, getCopyTextWithoutAfterglow, showTemporaryCopiedFeedback } from './copy-text'

const MARKDOWN_STREAM_MIN_DELAY_MS = 50

function useIsDark(): boolean {
  return useSyncExternalStore(
    (callback) => {
      if (typeof document === 'undefined') return () => {}
      const observer = new MutationObserver(callback)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => observer.disconnect()
    },
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
    () => false,
  )
}

const MARKDOWN_INCOMPLETE_COMPONENTS = {
  link: 'incomplete-link',
  image: 'incomplete-image',
  table: 'incomplete-table',
} as const

const AfterglowLine = memo(function AfterglowLine({ text }: { text: string }) {
  return (
    <p
      className="my-1.5 select-none text-[13px] italic leading-6 text-[color:color-mix(in_oklab,var(--lume-text-muted)_70%,transparent)]"
      aria-hidden="true"
      data-afterglow="true"
      data-afterglow-text={`⟡ ${text}`}
    >
      <span className="opacity-70">⟡</span>
      <span className="ml-1.5">{text}</span>
    </p>
  )
})

export const SmoothText = memo(function SmoothText({
  text,
  isStreaming,
  threadId,
  onOpenThreadFile,
}: {
  text: string
  isStreaming: boolean
  threadId: string
  onOpenThreadFile?: OpenThreadFile
}) {
  const { displayedContent } = useSmoothStream({
    content: text,
    isStreaming,
    minDelay: MARKDOWN_STREAM_MIN_DELAY_MS,
  })
  const isDark = useIsDark()
  const markdownStreaming = useMemo(() => ({
    hasNextChunk: isStreaming,
    enableAnimation: isStreaming,
    tail: isStreaming,
    incompleteMarkdownComponentMap: MARKDOWN_INCOMPLETE_COMPONENTS,
  }), [isStreaming])
  const markdownComponents = useMemo(() => ({
    pre: (props: MarkdownPreProps) => <MarkdownPre {...props} />,
    code: (props: MarkdownCodeProps) => (
      <MarkdownCode
        {...props}
        onOpenThreadFile={onOpenThreadFile}
      />
    ),
    a: (props: MarkdownAnchorProps) => <MarkdownAnchor {...props} threadId={threadId} onOpenThreadFile={onOpenThreadFile} />,
    'incomplete-link': IncompleteLink,
    'incomplete-image': IncompleteImage,
    'incomplete-table': IncompleteTable,
  }), [onOpenThreadFile, threadId])
  const afterglowBlocks = useMemo(
    () => displayedContent.includes('⟡') ? parseAfterglowBlocks(displayedContent) : null,
    [displayedContent],
  )
  const handleCopy = useMemo(() => (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const fragment = selection.getRangeAt(0).cloneContents()
    const text = getCopyTextWithoutAfterglow(fragment)
    if (!text) return
    event.preventDefault()
    void writeClipboardText(text).catch((error) => {
      console.error('[SmoothText] 复制选区失败:', error)
      toast.error('复制失败')
    })
  }, [])
  const renderMarkdown = (content: string, key?: string) => (
    <XMarkdown
      key={key}
      className="agent-message-markdown x-markdown text-chat text-[var(--lume-text-primary)]"
      rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
      streaming={markdownStreaming}
      components={markdownComponents}
    >
      {content}
    </XMarkdown>
  )

  return (
    <div className="min-w-0 w-full" onCopy={handleCopy}>
      {afterglowBlocks === null
        ? renderMarkdown(displayedContent)
        : (() => {
            const afterglowItems = afterglowBlocks.filter((b): b is Extract<typeof b, { type: 'afterglow' }> => b.type === 'afterglow')
            return (
              <>
                {afterglowBlocks.map((block, index) =>
                  block.type === 'afterglow'
                    ? null
                    : block.text.trim()
                      ? renderMarkdown(block.text, `markdown:${index}`)
                      : null,
                )}
                {afterglowItems.map((block, index) => (
                  <AfterglowLine key={`afterglow:${index}`} text={block.text} />
                ))}
              </>
            )
          })()}
    </div>
  )
})

export function PlanPreviewCard({
  preview,
  onOpenThreadFile,
}: {
  preview: PlanPreviewView
  onOpenThreadFile?: OpenThreadFile
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const feedbackStateRef = useRef<CopyFeedbackState>({ resetTimeoutId: null })
  const canOpenFile = Boolean(preview.planFilePath && onOpenThreadFile)

  useEffect(() => () => {
    if (feedbackStateRef.current.resetTimeoutId !== null) {
      window.clearTimeout(feedbackStateRef.current.resetTimeoutId)
      feedbackStateRef.current.resetTimeoutId = null
    }
  }, [])

  const handleCopy = async () => {
    try {
      await writeClipboardText(getAssistantCopyText(preview.markdown))
      showTemporaryCopiedFeedback(feedbackStateRef.current, {
        setCopied,
        setTimer: window.setTimeout,
        clearTimer: window.clearTimeout,
      })
    } catch (error) {
      console.error('[PlanPreviewCard] 复制计划失败:', error)
    }
  }

  return (
    <article
      data-plan-preview-card="true"
      data-state={expanded ? 'expanded' : 'collapsed'}
      className="w-full max-w-[920px] overflow-hidden rounded-[18px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-5 py-5 shadow-[0_18px_50px_-36px_hsl(var(--lume-shadow-panel)/0.62)]"
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold leading-5 text-[var(--lume-text-primary)]">计划</div>
          <h3 className="mt-6 text-[28px] font-semibold leading-[1.18] tracking-normal text-[var(--lume-text-primary)]">
            {preview.title}
          </h3>
          {preview.summary && (
            <p className="mt-3 text-[15px] leading-7 text-[var(--lume-text-secondary)]">{preview.summary}</p>
          )}
          {preview.planFilePath && (
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--lume-text-muted)]">
              <FileText size={13} className="shrink-0" />
              <span className="truncate font-mono">{preview.planFilePath}</span>
              {preview.planVerified ? <span className="shrink-0 text-[var(--lume-success)]">已验证</span> : null}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 text-[var(--lume-text-muted)]">
          <Button
                variant="ghost"
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-text-primary)]"
            title={copied ? '已复制' : '复制 Markdown'}
            aria-label="复制计划"
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            <span>复制计划</span>
          </Button>
          {preview.planFilePath && (
            <Button
                variant="ghost"
              type="button"
              onClick={() => {
                if (preview.planFilePath) onOpenThreadFile?.(preview.planFilePath)
              }}
              disabled={!canOpenFile}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              title={preview.planFilePath}
            >
              <FileText size={15} />
              <span>打开计划文件</span>
            </Button>
          )}
          <Button
                variant="ghost"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-text-primary)]"
            aria-label={expanded ? '收起计划' : '展开计划'}
          >
            <ChevronDown size={16} className={cn('transition-transform', expanded && 'rotate-180')} />
            <span>{expanded ? '收起计划' : '展开计划'}</span>
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="relative mt-6">
          <PlanPreviewMarkdown markdown={preview.markdown} onOpenThreadFile={onOpenThreadFile} />
        </div>
      )}
    </article>
  )
}

const PlanPreviewMarkdown = memo(function PlanPreviewMarkdown({
  markdown,
  onOpenThreadFile,
}: {
  markdown: string
  onOpenThreadFile?: OpenThreadFile
}) {
  const isDark = useIsDark()
  const components = useMemo(() => ({
    pre: (props: MarkdownPreProps) => <MarkdownPre {...props} />,
    code: (props: MarkdownCodeProps) => (
      <MarkdownCode
        {...props}
        onOpenThreadFile={onOpenThreadFile}
      />
    ),
    a: (props: MarkdownAnchorProps) => <MarkdownAnchor {...props} onOpenThreadFile={onOpenThreadFile} />,
  }), [onOpenThreadFile])

  return (
    <XMarkdown
      className="agent-message-markdown x-markdown text-chat text-[var(--lume-text-primary)]"
      rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
      components={components}
    >
      {markdown}
    </XMarkdown>
  )
})

type MarkdownCodeProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode
  class?: string
  block?: boolean
  lang?: string
  domNode?: unknown
  streamStatus?: unknown
}

type MarkdownAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children?: ReactNode
}

type MarkdownPreProps = HTMLAttributes<HTMLPreElement> & {
  children?: ReactNode
  domNode?: unknown
  streamStatus?: unknown
}

async function copyMermaidToClipboard(code: string): Promise<void> {
  try {
    await writeClipboardText(code)
  } catch (error) {
    console.error('[MarkdownPre] 复制 Mermaid 源码失败:', error)
    toast.error('复制失败')
    throw error
  }
}

async function copyMermaidImageToClipboard(svg: string): Promise<void> {
  try {
    await writeClipboardImage({ dataUrl: await mermaidSvgToPngDataUrl(svg) })
  } catch (error) {
    console.error('[MarkdownPre] 复制 Mermaid 图片失败:', error)
    toast.error('复制图片失败')
    throw error
  }
}

export function MarkdownPre({
  children,
  domNode,
  streamStatus,
  ...rest
}: MarkdownPreProps) {
  const [mermaidPreviewSvg, setMermaidPreviewSvg] = useState<string | null>(null)
  const [mermaidOriginalSize, setMermaidOriginalSize] = useState(false)
  const mermaidCode = getMermaidCodeFromPreNode(domNode)
  if (mermaidCode !== null) {
    if (streamStatus === 'loading' || isMermaidPreStreaming(domNode)) {
      return <pre {...rest}>{children}</pre>
    }
    const closeMermaidPreview = () => {
      setMermaidPreviewSvg(null)
      setMermaidOriginalSize(false)
    }
    const mermaidPreviewSrc = mermaidPreviewSvg
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mermaidPreviewSvg)}`
      : undefined

    return (
      <>
        <MermaidBlock
          code={mermaidCode}
          onCopy={copyMermaidToClipboard}
          onCopyImage={copyMermaidImageToClipboard}
          onPreview={setMermaidPreviewSvg}
        />
        <Dialog open={Boolean(mermaidPreviewSvg)} onOpenChange={(open) => { if (!open) closeMermaidPreview() }}>
          <DialogContent
            showCloseButton={false}
            className="inset-0 left-0 top-0 z-[151] block h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-auto rounded-none bg-black/92 p-4 ring-0 sm:max-w-none"
            onClick={closeMermaidPreview}
          >
            <DialogTitle className="sr-only">预览 Mermaid 图表</DialogTitle>
            <div className="fixed right-4 top-4 z-10 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="bg-black/35 text-white hover:bg-white/15 hover:text-white"
                onClick={() => setMermaidOriginalSize((value) => !value)}
              >
                {mermaidOriginalSize ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                {mermaidOriginalSize ? '适应窗口' : '原始尺寸'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="bg-black/35 text-white hover:bg-white/15 hover:text-white"
                onClick={closeMermaidPreview}
                aria-label="关闭 Mermaid 预览"
              >
                <X size={18} />
              </Button>
            </div>
            {mermaidPreviewSrc && (
              <div className={mermaidOriginalSize ? 'min-h-full min-w-full' : 'flex h-full w-full items-center justify-center'}>
                <img
                  src={mermaidPreviewSrc}
                  alt="Mermaid 图表"
                  className={mermaidOriginalSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={() => setMermaidOriginalSize((value) => !value)}
                />
              </div>
            )}
          </DialogContent>
        </Dialog>
      </>
    )
  }

  const infographicCode = getInfographicCodeFromPreNode(domNode)
  if (infographicCode !== null) {
    return (
      <InfographicBlock
        code={infographicCode}
        streaming={streamStatus === 'loading' || isInfographicPreStreaming(domNode)}
      />
    )
  }

  return <DiffAwareMarkdownPre streamStatus={streamStatus}>{children}</DiffAwareMarkdownPre>
}

export function MarkdownCode({
  children,
  block,
  lang: _lang,
  domNode: _domNode,
  streamStatus: _streamStatus,
  onOpenThreadFile,
  ...rest
}: MarkdownCodeProps & { onOpenThreadFile?: OpenThreadFile }) {
  const binding = useMessageFileReferenceBinding()
  const protocolVersion = useMessageFileReferenceProtocolVersion()
  const text = flattenText(children)
  const reference = !block ? parseMessageThreadFileReference(text, {
    bindingPresent: Boolean(binding),
    protocolVersion,
  }) : null

  if (reference && onOpenThreadFile) {
    return <AgentFileReference reference={reference} binding={binding} onOpen={onOpenThreadFile} />
  }

  const codeProps = normalizeMarkdownCodeProps(rest as Record<string, unknown>) as HTMLAttributes<HTMLElement>
  return <code {...codeProps}>{children}</code>
}

/** 外链 href 兜底白名单：不依赖上游 x-markdown 的 DOMPurify 配置，非 http/https/mailto 不输出 href。 */
export function isSafeExternalHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href)
}

export function MarkdownAnchor({
  href,
  children,
  threadId,
  onOpenThreadFile,
  ...rest
}: MarkdownAnchorProps & { threadId?: string; onOpenThreadFile?: OpenThreadFile }) {
  const binding = useMessageFileReferenceBinding()
  const protocolVersion = useMessageFileReferenceProtocolVersion()
  const reference = typeof href === 'string' && (href.startsWith('@project/') || href.startsWith('@session/'))
    ? parseMessageThreadFileReference(href, { bindingPresent: Boolean(binding), protocolVersion, markdownHref: true })
    : null
  if (reference && onOpenThreadFile) {
    return <AgentFileReference reference={reference} binding={binding} onOpen={onOpenThreadFile} />
  }
  const safeHref = typeof href === 'string' && isSafeExternalHref(href) ? href : undefined
  return (
    <a
      {...rest}
      href={safeHref}
      onClick={rest.onClick}
    >
      {children}
    </a>
  )
}

export function normalizeMarkdownCodeProps(props: Record<string, unknown>): Record<string, unknown> {
  const {
    class: rawClassName,
    className,
    ...rest
  } = props
  const normalizedClassName = cn(
    typeof rawClassName === 'string' ? rawClassName : undefined,
    typeof className === 'string' ? className : undefined,
  )
  return {
    ...rest,
    ...(normalizedClassName ? { className: normalizedClassName } : {}),
  }
}

function flattenText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(flattenText).join('')
  return ''
}

function IncompleteLink() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted/30 px-2 py-0.5 text-[13px] text-muted-foreground/50 animate-pulse">
      <span className="inline-block h-3 w-16 rounded bg-muted/50" />
    </span>
  )
}

function IncompleteImage() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded bg-muted/30 px-2 py-1 text-[12px] text-muted-foreground/40 animate-pulse">
      <span className="inline-block size-4 rounded bg-muted/50" />
      <span className="inline-block h-3 w-12 rounded bg-muted/50" />
    </span>
  )
}

function IncompleteTable() {
  return (
    <div className="my-1 overflow-hidden rounded border border-border/20 animate-pulse">
      <div className="flex gap-px bg-muted/20">
        <span className="h-4 flex-1 bg-muted/30" />
        <span className="h-4 flex-1 bg-muted/30" />
        <span className="h-4 flex-1 bg-muted/30" />
      </div>
      <div className="flex gap-px bg-muted/10">
        <span className="h-4 flex-1 bg-muted/20" />
        <span className="h-4 flex-1 bg-muted/20" />
        <span className="h-4 flex-1 bg-muted/20" />
      </div>
    </div>
  )
}
