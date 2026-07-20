import { AGENT_ATTACHMENT_LIMITS } from '@lume/shared'

export const MAX_PENDING_ATTACHMENT_COUNT = AGENT_ATTACHMENT_LIMITS.maxCount
export const MAX_PENDING_ATTACHMENT_FILE_BYTES = AGENT_ATTACHMENT_LIMITS.maxFileBytes
export const MAX_PENDING_ATTACHMENT_TOTAL_BYTES = AGENT_ATTACHMENT_LIMITS.maxTotalBytes

export type PendingAttachmentRejectionReason =
  | 'invalid_size'
  | 'file_too_large'
  | 'count_limit'
  | 'total_limit'

export interface PendingAttachmentLike {
  filename: string
  size: number
}

export interface PendingAttachmentRejection<T> {
  attachment: T
  reason: PendingAttachmentRejectionReason
}

export function validatePendingAttachmentBatch<T extends PendingAttachmentLike>(
  existing: readonly PendingAttachmentLike[],
  candidates: readonly T[],
): { accepted: T[]; rejected: Array<PendingAttachmentRejection<T>> } {
  const accepted: T[] = []
  const rejected: Array<PendingAttachmentRejection<T>> = []
  let count = existing.length
  let totalBytes = existing.reduce((sum, attachment) => sum + Math.max(0, attachment.size), 0)

  for (const attachment of candidates) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      rejected.push({ attachment, reason: 'invalid_size' })
      continue
    }
    if (attachment.size > MAX_PENDING_ATTACHMENT_FILE_BYTES) {
      rejected.push({ attachment, reason: 'file_too_large' })
      continue
    }
    if (count >= MAX_PENDING_ATTACHMENT_COUNT) {
      rejected.push({ attachment, reason: 'count_limit' })
      continue
    }
    if (totalBytes + attachment.size > MAX_PENDING_ATTACHMENT_TOTAL_BYTES) {
      rejected.push({ attachment, reason: 'total_limit' })
      continue
    }
    accepted.push(attachment)
    count += 1
    totalBytes += attachment.size
  }

  return { accepted, rejected }
}

export function pendingAttachmentRejectionMessage(reason: PendingAttachmentRejectionReason): string {
  if (reason === 'file_too_large') return '单个文件不能超过 25 MB'
  if (reason === 'count_limit') return '每条消息最多添加 10 个附件'
  if (reason === 'total_limit') return '附件总大小不能超过 50 MB'
  return '文件大小无效'
}
