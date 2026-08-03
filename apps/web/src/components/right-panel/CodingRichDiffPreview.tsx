import { useEffect, useMemo, useState } from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import {
  AGENT_IPC_CHANNELS,
  type CodingDiffMediaResult,
  type CodingDiffPayload,
  type CodingReviewSource,
} from '@lume/shared'
import { DIFF_AWARE_MARKDOWN_COMPONENTS } from '@/components/markdown/DiffAwareMarkdownPre'
import { sidecarCall } from '@/lib/desktop-api'

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function useMediaUrl(input: {
  threadId: string
  runId?: string
  rootId?: string
  path: string
  side: 'before' | 'after'
  reviewSource?: CodingReviewSource
  enabled: boolean
}) {
  const [state, setState] = useState<{ url?: string; mediaType?: string; error?: string }>({})
  useEffect(() => {
    if (!input.enabled) {
      setState({})
      return
    }
    let cancelled = false
    let objectUrl: string | undefined
    void sidecarCall<CodingDiffMediaResult>(AGENT_IPC_CHANNELS.GET_CODING_DIFF_MEDIA, input)
      .then((result) => {
        if (cancelled) return
        const bytes = bytesFromBase64(result.dataBase64)
        objectUrl = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: result.mediaType }))
        setState({ url: objectUrl, mediaType: result.mediaType })
      })
      .catch((error) => {
        if (!cancelled) setState({ error: error instanceof Error ? error.message : '媒体预览加载失败' })
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [input.enabled, input.path, input.reviewSource, input.rootId, input.runId, input.side, input.threadId])
  return state
}

export function CodingRichDiffPreview({
  threadId,
  runId,
  reviewSource,
  review,
}: {
  threadId: string
  runId?: string
  reviewSource?: CodingReviewSource
  review: CodingDiffPayload
}) {
  if (review.kind === 'text' && /\.(?:md|markdown|mdown|mdx|mkd)$/i.test(review.path)) {
    return (
      <div className="bg-[var(--lume-bg-app)] p-5">
        <XMarkdown components={DIFF_AWARE_MARKDOWN_COMPONENTS} className="x-markdown text-[14px] leading-7">
          {review.newContent}
        </XMarkdown>
      </div>
    )
  }
  if (review.kind === 'text' && /\.svg$/i.test(review.path)) {
    return <SvgPreview content={review.newContent} />
  }
  if (review.kind !== 'media') return <BinaryPlaceholder />
  return (
    <MediaBeforeAfter
      threadId={threadId}
      runId={runId}
      reviewSource={reviewSource}
      review={review}
    />
  )
}

function SvgPreview({ content }: { content: string }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' })), [content])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return (
    <div className="flex min-h-48 items-center justify-center bg-[var(--lume-bg-app)] p-6">
      <img src={url} alt="SVG 预览" className="max-h-[60vh] max-w-full object-contain" />
    </div>
  )
}

function MediaBeforeAfter({
  threadId,
  runId,
  reviewSource,
  review,
}: {
  threadId: string
  runId?: string
  reviewSource?: CodingReviewSource
  review: Extract<CodingDiffPayload, { kind: 'media' }>
}) {
  const before = useMediaUrl({
    threadId,
    runId,
    rootId: review.rootId,
    path: review.path,
    side: 'before',
    reviewSource,
    enabled: review.beforeAvailable,
  })
  const after = useMediaUrl({
    threadId,
    runId,
    rootId: review.rootId,
    path: review.path,
    side: 'after',
    reviewSource,
    enabled: review.afterAvailable,
  })
  return (
    <div className="grid min-h-48 grid-cols-2 divide-x divide-[var(--lume-border-subtle)] bg-[var(--lume-bg-app)]">
      <MediaSide title="修改前" url={before.url} mediaType={before.mediaType} error={before.error} available={review.beforeAvailable} />
      <MediaSide title="修改后" url={after.url} mediaType={after.mediaType} error={after.error} available={review.afterAvailable} />
    </div>
  )
}

function MediaSide({ title, url, mediaType, error, available }: {
  title: string
  url?: string
  mediaType?: string
  error?: string
  available: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="border-b border-[var(--lume-border-subtle)] px-3 py-1.5 text-xs text-[var(--lume-text-muted)]">{title}</div>
      <div className="flex h-[min(56vh,34rem)] items-center justify-center p-3">
        {!available ? <span className="text-xs text-[var(--lume-text-muted)]">无此版本</span>
          : error ? <span className="text-xs text-[var(--lume-danger)]">{error}</span>
            : !url ? <span className="text-xs text-[var(--lume-text-muted)]">正在加载…</span>
              : mediaType === 'application/pdf'
                ? <object data={url} type="application/pdf" className="h-full w-full"><a href={url}>打开 PDF</a></object>
                : <img src={url} alt={title} className="max-h-full max-w-full object-contain" />}
      </div>
    </div>
  )
}

function BinaryPlaceholder() {
  return (
    <div className="flex min-h-32 items-center justify-center bg-[var(--lume-bg-app)] text-xs text-[var(--lume-text-muted)]">
      二进制文件无法显示
    </div>
  )
}
