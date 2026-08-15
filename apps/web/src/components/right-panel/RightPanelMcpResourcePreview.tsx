import { useEffect, useState } from 'react'
import { XMarkdown } from '@ant-design/x-markdown'
import type { McpResourceSummary, ReadMcpResourceResponse } from '@lume/shared'
import { DIFF_AWARE_MARKDOWN_COMPONENTS } from '@/components/markdown/DiffAwareMarkdownPre'
import { readMcpResource, writeClipboardText } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { RightPanelSourcePreview } from './RightPanelSourcePreview'

export function RightPanelMcpResourcePreview({
  workspaceSlug,
  resource,
  hideTitle,
}: {
  workspaceSlug: string
  resource: McpResourceSummary
  hideTitle?: boolean
}) {
  const [result, setResult] = useState<ReadMcpResourceResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    setResult(null)
    setError(null)
    void readMcpResource({ workspaceSlug, serverId: resource.serverId, uri: resource.uri })
      .then((value) => { if (!disposed) setResult(value) })
      .catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : 'MCP 资源读取失败') })
    return () => { disposed = true }
  }, [resource.serverId, resource.uri, workspaceSlug])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        {!hideTitle && <span className="min-w-0 flex-1 truncate text-xs font-medium">{resource.name || resource.uri}</span>}
        {hideTitle && <span className="min-w-0 flex-1" />}
        <span className="truncate text-[10px] text-foreground/45">{resource.serverName}</span>
        <Button variant="ghost" size="xs" onClick={() => void writeClipboardText(resource.uri)}>复制 URI</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? <ResourceStatus>{error}</ResourceStatus>
          : !result ? <ResourceStatus>正在读取 MCP 资源…</ResourceStatus>
            : result.contents.length === 0 ? <ResourceStatus>资源没有可显示的内容</ResourceStatus>
              : result.contents.map((content, index) => (
                  <McpContent key={index} content={content} fallbackMimeType={resource.mimeType} name={resource.name || resource.uri} />
                ))}
      </div>
    </div>
  )
}

function McpContent({ content, fallbackMimeType, name }: { content: unknown; fallbackMimeType?: string; name: string }) {
  const record = content && typeof content === 'object' ? content as Record<string, unknown> : null
  const mimeType = typeof record?.mimeType === 'string' ? record.mimeType : fallbackMimeType
  const text = typeof record?.text === 'string' ? record.text : typeof content === 'string' ? content : null
  const blob = typeof record?.blob === 'string' ? record.blob : null
  const blobUrl = useBlobUrl(blob, mimeType)
  if (text !== null) {
    if (mimeType?.includes('markdown')) {
      return <div><ResourceActions copyText={text} /><div className="x-markdown p-4 text-[13px] leading-6"><XMarkdown components={DIFF_AWARE_MARKDOWN_COMPONENTS}>{text}</XMarkdown></div></div>
    }
    if (mimeType?.includes('json')) {
      const formatted = formatStructuredText(text)
      return <div><ResourceActions copyText={formatted} /><pre className="m-0 whitespace-pre-wrap p-4 text-xs">{formatted}</pre></div>
    }
    return <div><ResourceActions copyText={text} /><RightPanelSourcePreview content={text} filePath={name} /></div>
  }
  if (blobUrl && mimeType?.startsWith('image/')) return <img src={blobUrl} alt={name} className="m-auto max-h-full max-w-full object-contain" />
  if (blobUrl && mimeType === 'application/pdf') return <object data={blobUrl} type={mimeType} className="h-full min-h-[480px] w-full" />
  if (blobUrl && mimeType?.startsWith('video/')) return <video src={blobUrl} controls className="m-auto max-h-full max-w-full" />
  const metadata = JSON.stringify(blob ? { ...record, blob: `[base64 ${blob.length} chars]` } : content, null, 2)
  return (
    <div>
      <ResourceActions copyText={metadata} downloadUrl={blobUrl} downloadName={name} />
      <pre className="m-0 whitespace-pre-wrap p-4 text-xs">{metadata}</pre>
    </div>
  )
}

function ResourceActions({ copyText, downloadUrl, downloadName }: {
  copyText: string
  downloadUrl?: string | null
  downloadName?: string
}) {
  return (
    <div className="flex h-8 items-center justify-end gap-1 border-b border-border/50 px-2">
      <Button variant="ghost" size="xs" onClick={() => void writeClipboardText(copyText)}>复制</Button>
      {downloadUrl && (
        <Button variant="ghost" size="xs" render={<a href={downloadUrl} download={downloadName || 'resource'} />}>
          下载
        </Button>
      )}
    </div>
  )
}

function useBlobUrl(base64: string | null, mimeType?: string): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!base64 || typeof URL === 'undefined') return
    try {
      const binary = atob(base64)
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      const next = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'application/octet-stream' }))
      setUrl(next)
      return () => URL.revokeObjectURL(next)
    } catch {
      return
    }
  }, [base64, mimeType])
  return url
}

function formatStructuredText(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

function ResourceStatus({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-48 items-center justify-center px-6 text-center text-sm text-foreground/50">{children}</div>
}
