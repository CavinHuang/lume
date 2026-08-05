import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
import { revokeFilePreviewScope } from '@/lib/desktop-api'
import { createThreadImagePreviewScope, type ThreadImageAttachmentRef } from './thread-image-preview'

export interface ThreadImageLightboxAttachment extends ThreadImageAttachmentRef {
  filename?: string
}

interface ThreadImageLightboxProps {
  attachment: ThreadImageLightboxAttachment | null
  threadId: string
  workspaceSlug?: string
  onClose: () => void
}

/**
 * 单张 thread 图片的全屏预览（lightbox）。
 * 点击消息中的图片附件时用其替代「右侧文件面板预览」，与 image-gen-result 的全屏预览体验保持一致。
 */
export function ThreadImageLightbox({ attachment, threadId, workspaceSlug, onClose }: ThreadImageLightboxProps) {
  const [previewSrc, setPreviewSrc] = useState<string | null | undefined>(undefined)
  const [originalSize, setOriginalSize] = useState(false)

  const attachmentKey = attachment
    ? [attachment.threadPath, attachment.fileRef?.source, attachment.fileRef?.scopeId, attachment.fileRef?.relativePath].filter(Boolean).join(':')
    : null

  useEffect(() => {
    if (!attachment) {
      setPreviewSrc(undefined)
      return
    }
    let cancelled = false
    let scopeToken: string | null = null
    setPreviewSrc(undefined)
    void createThreadImagePreviewScope(attachment, { threadId, ...(workspaceSlug ? { workspaceSlug } : {}) })
      .then((scope) => {
        if (cancelled) {
          void revokeFilePreviewScope(scope.token).catch(() => undefined)
          return
        }
        scopeToken = scope.token
        setPreviewSrc(scope.url)
      })
      .catch((error) => {
        console.error('[ThreadImageLightbox] 加载图片失败:', error)
        if (!cancelled) setPreviewSrc(null)
      })
    return () => {
      cancelled = true
      if (scopeToken) void revokeFilePreviewScope(scopeToken).catch(() => undefined)
    }
    // 依赖 attachmentKey（threadPath+fileRef 拼接）而非 attachment 引用，避免每次渲染重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, workspaceSlug, attachmentKey])

  // 切换图片时重置缩放模式
  useEffect(() => {
    setOriginalSize(false)
  }, [attachmentKey])

  const open = Boolean(attachment && previewSrc)
  const filename = attachment?.filename ?? attachment?.threadPath ?? ''

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 left-0 top-0 z-[151] block h-dvh w-dvw max-w-none translate-x-0 translate-y-0 overflow-auto rounded-none bg-black/92 p-4 ring-0 sm:max-w-none"
        onClick={onClose}
      >
        <DialogTitle className="sr-only">查看图片 {filename}</DialogTitle>
        <div className="fixed right-4 top-4 z-10 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="bg-black/35 text-white hover:bg-white/15 hover:text-white"
            onClick={() => setOriginalSize((value) => !value)}
          >
            {originalSize ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            {originalSize ? '适应窗口' : '原始尺寸'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="bg-black/35 text-white hover:bg-white/15 hover:text-white"
            onClick={onClose}
            aria-label="关闭图片预览"
          >
            <X size={18} />
          </Button>
        </div>
        {previewSrc && attachment && (
          <div className={originalSize ? 'min-h-full min-w-full' : 'flex h-full w-full items-center justify-center'}>
            <FileLinkContextMenu
              context={{ source: 'thread', relPath: attachment.threadPath, threadId, workspaceSlug, fileRef: attachment.fileRef }}
              isImage
              directTrigger
            >
              <img
                src={previewSrc}
                alt={filename}
                className={originalSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={() => setOriginalSize((value) => !value)}
              />
            </FileLinkContextMenu>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
