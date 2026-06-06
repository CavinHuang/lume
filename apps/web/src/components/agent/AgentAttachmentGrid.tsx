import { FileText, X } from 'lucide-react'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { cn } from '@/lib/utils'

export interface AgentAttachmentGridItem {
  id: string
  filename: string
  mediaType: string
  size: number
  threadPath?: string
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
        return (
          <div
            key={attachment.id}
            data-agent-attachment-kind={image ? 'image' : 'file'}
            className={cn('group/attachment relative min-w-0', image ? 'h-[108px] w-[108px]' : 'h-[108px] w-[250px] max-w-full')}
          >
            <button
              type="button"
              onClick={() => image ? onOpenImage?.(attachment) : onOpenFile?.(attachment)}
              className={cn(
                'flex h-full w-full min-w-0 overflow-hidden rounded-[12px] border text-left shadow-[0_1px_0_rgba(15,23,42,0.03)] transition-colors',
                image
                  ? 'items-center justify-center border-[#e2e4ec] bg-white hover:border-[#cacfdc]'
                  : 'items-center gap-4 border-[#e2e4ec] bg-white p-3 hover:border-[#cacfdc]',
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
                  <div className="flex h-full w-full items-center justify-center bg-[#f7f5ff] text-[#8b7df1]">
                    <FileTypeIcon filename={attachment.filename} size={24} />
                  </div>
                )
              ) : (
                <>
                  <span className="flex size-16 shrink-0 items-center justify-center rounded-[12px] bg-[#f7f7f8] text-[#8b7df1]">
                    <FileTypeIcon filename={attachment.filename} size={30} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[18px] font-semibold leading-6 text-[#1f232b]">
                      {attachment.filename}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5 text-[17px] font-medium uppercase leading-6 text-[#8d929f]">
                      <FileText size={14} />
                      {getFileExtension(attachment.filename).toUpperCase() || 'FILE'}
                    </span>
                  </span>
                </>
              )}
            </button>
            {removable && (
              <button
                type="button"
                onClick={() => onRemove?.(attachment.id)}
                disabled={removeDisabled}
                className="absolute -right-1.5 -top-1.5 flex size-7 items-center justify-center rounded-full bg-[#17191f] text-white opacity-95 shadow-[0_4px_12px_rgba(23,25,31,0.18)] transition-colors hover:bg-[#2b2f3a] disabled:cursor-not-allowed disabled:opacity-45"
                title="移除附件"
              >
                <X size={13} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function getFileExtension(filename: string): string {
  const ext = filename.split('.').pop()?.trim()
  return ext && ext !== filename ? ext : ''
}
