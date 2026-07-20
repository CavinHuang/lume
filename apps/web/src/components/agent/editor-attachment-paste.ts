import { isImageAttachment } from './AgentAttachmentGrid'
import {
  validatePendingAttachmentBatch,
  type PendingAttachmentLike,
  type PendingAttachmentRejectionReason,
} from './pending-attachment-validation'
import { stageAttachmentFile } from '@/lib/desktop-api/native'

export interface PastedPendingAttachment {
  id: string
  filename: string
  mediaType: string
  size: number
  stagedAttachmentId: string
  previewUrl?: string
}

export function handleAttachmentPaste(
  event: ClipboardEvent,
  handlers: {
    onStart?: (fileCount: number) => void
    onAttachments: (attachments: PastedPendingAttachment[]) => void
    existingAttachments?: readonly PendingAttachmentLike[]
    onRejected?: (items: Array<{ file: File; reason: PendingAttachmentRejectionReason }>) => void
    stageFile?: typeof stageAttachmentFile
    onError: (error: unknown) => void
    onSettled?: () => void
  },
): boolean {
  const files = extractClipboardFiles(event.clipboardData)
  if (files.length === 0) return false

  event.preventDefault()
  const candidates = files.map((file) => ({ filename: file.name || '剪贴板文件', size: file.size, file }))
  const validation = validatePendingAttachmentBatch(handlers.existingAttachments ?? [], candidates)
  handlers.onRejected?.(validation.rejected.map(({ attachment, reason }) => ({ file: attachment.file, reason })))
  const acceptedFiles = validation.accepted.map((attachment) => attachment.file)
  if (acceptedFiles.length === 0) {
    handlers.onSettled?.()
    return true
  }

  handlers.onStart?.(acceptedFiles.length)
  void createPendingAttachmentsFromFiles(acceptedFiles, { stageFile: handlers.stageFile })
    .then(handlers.onAttachments)
    .catch(handlers.onError)
    .finally(handlers.onSettled)
  return true
}

export function extractClipboardFiles(clipboardData: DataTransfer | null | undefined): File[] {
  if (!clipboardData) return []

  const files = Array.from(clipboardData.files ?? [])
  if (files.length > 0) return files

  return Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export async function createPendingAttachmentsFromFiles(
  files: File[],
  options: {
    createId?: () => string
    now?: number
    stageFile?: typeof stageAttachmentFile
  } = {},
): Promise<PastedPendingAttachment[]> {
  const createId = options.createId ?? createPendingAttachmentId
  const now = options.now ?? Date.now()
  const stageFile = options.stageFile ?? stageAttachmentFile

  return Promise.all(files.map(async (file, index) => {
    const id = createId()
    const mediaType = file.type || 'application/octet-stream'
    const filename = resolvePastedFilename(file, index, now)
    const staged = await stageFile({ id, file, filename, mediaType })

    return {
      id,
      filename,
      mediaType,
      size: file.size,
      stagedAttachmentId: staged.stagedAttachmentId,
      ...(isImageAttachment({ filename, mediaType }) && staged.previewUrl
        ? { previewUrl: staged.previewUrl }
        : {}),
    }
  }))
}

function resolvePastedFilename(file: File, index: number, now: number): string {
  const filename = file.name?.trim()
  if (filename) return filename

  const prefix = file.type.startsWith('image/') ? 'pasted-image' : 'pasted-file'
  const extension = extensionForMediaType(file.type)
  return `${prefix}-${now}-${index + 1}.${extension}`
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/jpeg': return 'jpg'
    case 'image/gif': return 'gif'
    case 'image/webp': return 'webp'
    case 'image/bmp': return 'bmp'
    case 'image/svg+xml': return 'svg'
    case 'text/plain': return 'txt'
    case 'application/pdf': return 'pdf'
    default: return mediaType === 'image/png' ? 'png' : 'bin'
  }
}

function createPendingAttachmentId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`
}
