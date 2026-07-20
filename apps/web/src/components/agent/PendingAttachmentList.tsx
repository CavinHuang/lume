import { X } from 'lucide-react'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { isImageAttachment, type AgentAttachmentGridItem } from './AgentAttachmentGrid'

interface PendingAttachmentListProps<T extends AgentAttachmentGridItem> {
  attachments: T[]
  removeDisabled?: boolean
  hideRemove?: boolean
  onRemove: (id: string) => void
}

export function PendingAttachmentList<T extends AgentAttachmentGridItem>({
  attachments,
  removeDisabled = false,
  hideRemove = false,
  onRemove,
}: PendingAttachmentListProps<T>) {
  if (attachments.length === 0) return null

  return (
    <ScrollArea className="max-h-[112px]" data-pending-attachments="true">
      <div className="flex flex-wrap gap-2 pr-2">
        {attachments.map((attachment) => {
        const image = isImageAttachment(attachment)
        return (
          <div
            key={attachment.id}
            className="flex h-11 min-w-0 max-w-[240px] items-center gap-2 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] p-1.5"
          >
            <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--lume-bg-elevated)] text-[var(--lume-accent)]">
              {image && attachment.previewUrl ? (
                <img src={attachment.previewUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <FileTypeIcon filename={attachment.filename} size={18} />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--lume-text-primary)]" title={attachment.filename}>
              {attachment.filename}
            </span>
            {!hideRemove && (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                disabled={removeDisabled}
                onClick={() => onRemove(attachment.id)}
                className="size-7 shrink-0 rounded-md text-[var(--lume-text-muted)] hover:text-[var(--lume-text-primary)]"
                aria-label={`移除 ${attachment.filename}`}
              >
                <X size={13} />
              </Button>
            )}
          </div>
        )
        })}
      </div>
    </ScrollArea>
  )
}
