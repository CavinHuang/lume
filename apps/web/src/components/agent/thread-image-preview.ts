import { AGENT_IPC_CHANNELS, type FileRef } from '@lume/shared'
import { createFilePreviewScope, sidecarCall } from '@/lib/desktop-api'
import type { ThreadFileEnv } from './thread-file-env'

export interface ThreadImageAttachmentRef {
  threadPath: string
  fileRef?: FileRef
}

interface ThreadImagePreviewScope {
  token: string
  url: string
  expiresAt: number
}

interface ThreadImagePreviewDeps {
  convertLegacyFileRef: (input: {
    recordKind: 'thread-attachment'
    threadId: string
    workspaceSlug?: string
    legacyRelativePath: string
  }) => Promise<FileRef>
  createPreviewScope: (input: { ref: FileRef; kind: 'media-file' }) => Promise<ThreadImagePreviewScope>
}

const defaultDeps: ThreadImagePreviewDeps = {
  convertLegacyFileRef: (input) => sidecarCall<FileRef>(AGENT_IPC_CHANNELS.CONVERT_LEGACY_FILE_REF, input),
  createPreviewScope: (input) => createFilePreviewScope(input),
}

export async function createThreadImagePreviewScope(
  attachment: ThreadImageAttachmentRef,
  env: ThreadFileEnv,
  deps: ThreadImagePreviewDeps = defaultDeps,
): Promise<ThreadImagePreviewScope> {
  if (!env.threadId) throw new Error('图片预览缺少 threadId')
  const ref = attachment.fileRef ?? await deps.convertLegacyFileRef({
    recordKind: 'thread-attachment',
    threadId: env.threadId,
    ...(env.workspaceSlug ? { workspaceSlug: env.workspaceSlug } : {}),
    legacyRelativePath: attachment.threadPath,
  })
  return deps.createPreviewScope({ ref, kind: 'media-file' })
}
