import { statFilePaths } from '@/lib/desktop-api'
import { attachmentDataUrl, isImageAttachment } from './AgentAttachmentGrid'
import type { PendingMessageAttachment } from './AgentInput'

export interface DesktopDroppedFile {
  id?: string
  filename: string
  mediaType: string
  size: number
  sourcePath: string
  stagedAttachmentId?: string
  data?: string
  previewUrl?: string
}

export type DragDropPayload =
  | { type: 'enter'; paths: string[] }
  | { type: 'over' }
  | { type: 'drop'; paths: string[] }
  | { type: 'leave' }

export function isFileDragPayload(payload: DragDropPayload): payload is Extract<DragDropPayload, { type: 'enter' | 'drop' }> {
  return (payload.type === 'enter' || payload.type === 'drop') && payload.paths.length > 0
}

export async function createPendingAttachmentsFromSourcePaths(
  paths: string[],
  options: {
    statPaths?: (paths: string[]) => Promise<{ files: DesktopDroppedFile[] }>
    createId?: () => string
  } = {}
): Promise<PendingMessageAttachment[]> {
  if (paths.length === 0) return []
  const statPaths = options.statPaths ?? statFilePaths
  const createId = options.createId ?? createPendingAttachmentId
  const result = await statPaths(paths)
  return result.files.map((file) => {
    const mediaType = file.mediaType || 'application/octet-stream'
    const legacyData = 'data' in file ? file.data : undefined
    return {
      id: file.id || createId(),
      filename: file.filename,
      mediaType,
      size: file.size,
      ...(file.stagedAttachmentId
        ? { stagedAttachmentId: file.stagedAttachmentId }
        : { sourcePath: file.sourcePath }),
      ...(legacyData ? { data: legacyData } : {}),
      ...(isImageAttachment({ filename: file.filename, mediaType }) && (file.previewUrl || legacyData)
        ? { previewUrl: file.previewUrl ?? attachmentDataUrl(mediaType, legacyData) }
        : {}),
    }
  })
}

function createPendingAttachmentId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`
}
