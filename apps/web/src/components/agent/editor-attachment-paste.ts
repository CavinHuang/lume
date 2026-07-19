import { attachmentDataUrl, isImageAttachment } from './AgentAttachmentGrid'

export interface PastedPendingAttachment {
  id: string
  filename: string
  mediaType: string
  size: number
  data: string
  previewUrl?: string
}

export function handleAttachmentPaste(
  event: ClipboardEvent,
  handlers: {
    onStart?: (fileCount: number) => void
    onAttachments: (attachments: PastedPendingAttachment[]) => void
    onError: (error: unknown) => void
    onSettled?: () => void
  },
): boolean {
  const files = extractClipboardFiles(event.clipboardData)
  if (files.length === 0) return false

  event.preventDefault()
  handlers.onStart?.(files.length)
  void createPendingAttachmentsFromFiles(files)
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
  } = {},
): Promise<PastedPendingAttachment[]> {
  const createId = options.createId ?? createPendingAttachmentId
  const now = options.now ?? Date.now()

  return Promise.all(files.map(async (file, index) => {
    const id = createId()
    const mediaType = file.type || 'application/octet-stream'
    const filename = resolvePastedFilename(file, index, now)
    const data = await fileToBase64(file)

    return {
      id,
      filename,
      mediaType,
      size: file.size,
      data,
      ...(isImageAttachment({ filename, mediaType })
        ? { previewUrl: attachmentDataUrl(mediaType, data) }
        : {}),
    }
  }))
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
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
