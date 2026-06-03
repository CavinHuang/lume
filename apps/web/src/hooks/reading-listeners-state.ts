import { READING_IPC_CHANNELS, type ReadingNoteGenerationNotification } from '@lume/shared'

export interface ReadingGenerationToast {
  kind: 'success' | 'error'
  message: string
}

export function buildReadingGenerationToast(method: string, params: unknown): ReadingGenerationToast | null {
  if (method !== READING_IPC_CHANNELS.NOTE_GEN_DONE && method !== READING_IPC_CHANNELS.NOTE_GEN_FAILED) {
    return null
  }

  const notification = params as Partial<ReadingNoteGenerationNotification>
  const title = notification.bookTitle?.trim()
  const bookLabel = title ? `《${title}》` : '读书笔记'

  if (method === READING_IPC_CHANNELS.NOTE_GEN_DONE) {
    return {
      kind: 'success',
      message: `${bookLabel}已写好读书笔记`,
    }
  }

  return {
    kind: 'error',
    message: `${bookLabel}暂时没有生成：${notification.message ?? '读书任务失败'}`,
  }
}
