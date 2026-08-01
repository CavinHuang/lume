import type { FileRef } from '@lume/shared'

export const FILE_REF_DRAG_MIME = 'application/x-lume-file-ref'

type FileRefDragTransfer = Pick<DataTransfer, 'getData'>

export function canDragFileRef(ref: FileRef): boolean {
  return (ref.source === 'project' || ref.source === 'session') && isSafeRelativePath(ref.relativePath)
}

export function serializeFileRefDragData(ref: FileRef): string {
  return JSON.stringify({
    source: ref.source,
    scopeId: ref.scopeId,
    relativePath: ref.relativePath,
  })
}

export function parseFileRefDragData(dataTransfer: FileRefDragTransfer): FileRef | null {
  const raw = dataTransfer.getData(FILE_REF_DRAG_MIME)
  if (!raw) return null

  try {
    const value = JSON.parse(raw) as Partial<FileRef>
    if (
      (value.source !== 'project' && value.source !== 'session')
      || typeof value.scopeId !== 'string'
      || typeof value.relativePath !== 'string'
      || !value.scopeId.trim()
      || !isSafeRelativePath(value.relativePath)
    ) return null
    return {
      source: value.source,
      scopeId: value.scopeId,
      relativePath: value.relativePath,
    }
  } catch {
    return null
  }
}

export function formatFileRefMention(ref: FileRef): string {
  return `@${ref.source}/${ref.relativePath}`
}

function isSafeRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  return Boolean(normalized)
    && !normalized.startsWith('/')
    && !normalized.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
}
