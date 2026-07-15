import { FileText, X } from 'lucide-react'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { FileLinkContextMenu } from '@/components/ui/FileLinkContextMenu'
import { useThreadFileEnv } from './thread-file-env'
import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
import type { FileRef } from '@lume/shared'
export interface AgentAttachmentGridItem {
  id: string
  filename: string
  mediaType: string
  size: number
  threadPath?: string
  fileRef?: FileRef
  previewUrl?: string
}

interface AgentAttachmentGridProps<T extends AgentAttachmentGridItem> {
  attachments: T[]
  align?: 'left' | 'right'
  removable?: boolean
  removeDisabled?: boolean
  imageSrcById?: Record<string, string | undefined>
  onRemove?: (id: string) => void
  onOpenFile?: (attachment: T) => void
  onOpenImage?: (attachment: T) => void
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

export function isImageAttachment(input: Pick<AgentAttachmentGridItem, 'filename' | 'mediaType'>): boolean {
  if (input.mediaType.toLowerCase().startsWith('image/')) return true
  const ext = getFileExtension(input.filename).toLowerCase()
  return ext ? IMAGE_EXTENSIONS.has(ext) : false
}

export function attachmentDataUrl(mediaType: string, data?: string): string | undefined {
  return data ? `data:${mediaType || 'application/octet-stream'};base64,${data}` : undefined
}

export function AgentAttachmentGrid<T extends AgentAttachmentGridItem>({
  attachments,
  align = 'left',
  removable = false,
  removeDisabled = false,
  imageSrcById = {},
  onRemove,
  onOpenFile,
  onOpenImage,
}: AgentAttachmentGridProps<T>) {
  const env = useThreadFileEnv()
  if (attachments.length === 0) return null

  return (
    <div
      data-agent-attachment-grid="true"
      className={cn(
        'flex w-full flex-wrap items-start gap-2',
        align === 'right' && 'ml-auto',
      )}
    >
      {attachments.map((attachment) => {
        const image = isImageAttachment(attachment)
        const previewUrl = imageSrcById[attachment.id] ?? attachment.previewUrl
        const attachNode = (
          <div
            key={attachment.id}
            data-agent-attachment-kind={image ? 'image' : 'file'}
            className={cn('group/attachment relative min-w-0', image ? 'h-[108px] w-[108px]' : 'h-[108px] w-[250px] max-w-full')}
          >
            <Button
                variant="ghost"
              type="button"
              onClick={() => image ? onOpenImage?.(attachment) : onOpenFile?.(attachment)}
              className={cn(
                'flex h-full w-full min-w-0 overflow-hidden rounded-[12px] border text-left shadow-[0_1px_0_hsl(var(--lume-shadow-panel)/0.08)] transition-colors duration-150 ease-out',
                image
                  ? 'items-center justify-center border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] hover:border-[var(--lume-border-strong)]'
                  : 'items-center gap-4 border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-3 hover:border-[var(--lume-border-strong)]',
              )}
              title={attachment.filename}
            >
              {image ? (
                previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={attachment.filename}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-[var(--lume-accent-soft)] text-[var(--lume-accent)]">
                    <FileTypeIcon filename={attachment.filename} size={24} />
                  </div>
                )
              ) : (
                <>
                  <span className="flex size-16 shrink-0 items-center justify-center rounded-[12px] bg-[var(--lume-bg-panel)] text-[var(--lume-accent)]">
                    <FileTypeIcon filename={attachment.filename} size={30} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[18px] font-semibold leading-6 text-[var(--lume-text-primary)]">
                      {attachment.filename}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5 text-[17px] font-medium uppercase leading-6 text-[var(--lume-text-muted)]">
                      <FileText size={14} />
                      {getFileExtension(attachment.filename).toUpperCase() || 'FILE'}
                    </span>
                  </span>
                </>
              )}
            </Button>
            {removable && (
              <Button
                variant="ghost"
                type="button"
                onClick={() => onRemove?.(attachment.id)}
                disabled={removeDisabled}
                className="absolute -right-1.5 -top-1.5 flex size-7 items-center justify-center rounded-full bg-[var(--lume-bg-app)] text-[var(--lume-text-primary)] opacity-95 shadow-[0_8px_18px_-14px_hsl(var(--lume-shadow-panel)/0.9)] transition-colors hover:bg-[var(--lume-bg-elevated)] disabled:cursor-not-allowed disabled:opacity-45"
                title="移除附件"
              >
                <X size={13} />
              </Button>
            )}
          </div>
        )

        const canMenu = Boolean(attachment.threadPath) && Boolean(env.threadId)
        return canMenu ? (
          <FileLinkContextMenu
            key={attachment.id}
            context={{ source: 'thread', relPath: attachment.threadPath!, threadId: env.threadId, workspaceSlug: env.workspaceSlug }}
            onPreview={() => (image ? onOpenImage?.(attachment) : onOpenFile?.(attachment))}
          >
            {attachNode}
          </FileLinkContextMenu>
        ) : attachNode
      })}
    </div>
  )
}

function getFileExtension(filename: string): string {
  const ext = filename.split('.').pop()?.trim()
  return ext && ext !== filename ? ext : ''
}
