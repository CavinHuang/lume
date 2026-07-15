import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileRef } from '@lume/shared'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  createFilePreviewScope,
  isDesktopRuntime,
  openExternal,
  revokeFilePreviewScope,
} from '@/lib/desktop-api'
import {
  createPreviewLinkRateLimiter,
  isHtmlPreviewMessageForScope,
  parseHtmlPreviewMessage,
  resolveHtmlPreviewLocalRef,
  isMissingFileError,
} from './file-preview-utils'

export function RightPanelHtmlPreview({
  fileRef,
  source,
  onOpenFile,
  onMissing,
  onPreviewScopeChange,
}: {
  fileRef: FileRef
  source: string
  onOpenFile: (ref: FileRef) => void
  onMissing?: (ref: FileRef) => void
  onPreviewScopeChange?: (token: string | null) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [scope, setScope] = useState<{ token: string; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingExternal, setPendingExternal] = useState<string | null>(null)
  const limiter = useMemo(() => createPreviewLinkRateLimiter({ max: 3, windowMs: 10_000 }), [])

  useEffect(() => {
    if (!isDesktopRuntime()) return
    let disposed = false
    let token: string | null = null
    setScope(null)
    setError(null)
    void createFilePreviewScope({ ref: fileRef, kind: 'html-directory' })
      .then((created) => {
        token = created.token
        if (disposed) {
          void revokeFilePreviewScope(created.token)
          return
        }
        setScope(created)
        onPreviewScopeChange?.(created.token)
      })
      .catch((nextError) => {
        if (!disposed) {
          setError(nextError instanceof Error ? nextError.message : 'HTML 预览创建失败')
          if (isMissingFileError(nextError)) onMissing?.(fileRef)
        }
      })
    return () => {
      disposed = true
      if (token) {
        void revokeFilePreviewScope(token)
        onPreviewScopeChange?.(null)
      }
    }
  }, [fileRef, onMissing, onPreviewScopeChange])

  useEffect(() => {
    if (!scope) return
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const message = parseHtmlPreviewMessage(event.data)
      if (!message || !isHtmlPreviewMessageForScope(message, scope.url)) return
      if (message.kind === 'local') {
        const target = resolveHtmlPreviewLocalRef(fileRef, message.href)
        if (target) onOpenFile(target)
        return
      }
      if (!limiter.allow()) return
      setPendingExternal(message.href)
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [fileRef, limiter, onOpenFile, scope])

  if (!isDesktopRuntime()) {
    return (
      <div className="space-y-3">
        <p className="text-[12px] text-foreground/55">交互渲染仅桌面端可用，当前显示源码。</p>
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5">{source}</pre>
      </div>
    )
  }

  if (error) return <div className="p-4 text-[13px] text-destructive">{error}</div>
  if (!scope) return <div className="p-4 text-[13px] text-foreground/55">正在创建安全 HTML 预览…</div>

  return (
    <>
      <iframe
        ref={iframeRef}
        src={scope.url}
        sandbox="allow-scripts"
        className="h-full min-h-[320px] w-full border-0 bg-white"
        title={fileRef.relativePath}
      />
      <ConfirmDialog
        open={Boolean(pendingExternal)}
        onOpenChange={(open) => { if (!open) setPendingExternal(null) }}
        title="打开外部链接？"
        description={pendingExternal ?? ''}
        confirmLabel="用默认浏览器打开"
        onConfirm={() => {
          const target = pendingExternal
          setPendingExternal(null)
          if (target) void openExternal(target)
        }}
      />
    </>
  )
}
