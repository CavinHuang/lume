import { useMemo } from 'react'
import { PierreDiffView, createPierreFileDiff } from '@/components/diff/PierreDiffView'

interface Props {
  input: Record<string, unknown>
  result: unknown
}

export function EditResult({ input, result }: Props) {
  const filePath = String(input.file_path ?? 'edited-file')
  const oldContent = String(input.old_string ?? '')
  const newContent = String(input.new_string ?? '')
  const resultPatch = (result as Record<string, unknown> | null)?.patch
  const patch = typeof resultPatch === 'string' && resultPatch.trim() ? resultPatch : undefined
  const diff = useMemo(() => {
    try {
      const files = createPierreFileDiff({ patch, oldContent, newContent, filePath })
      return {
        patch,
        addedLines: files.reduce((sum, file) => sum + file.hunks.reduce((count, hunk) => count + hunk.additionLines, 0), 0),
        removedLines: files.reduce((sum, file) => sum + file.hunks.reduce((count, hunk) => count + hunk.deletionLines, 0), 0),
      }
    } catch {
      const files = createPierreFileDiff({ oldContent, newContent, filePath })
      return {
        patch: undefined,
        addedLines: files.reduce((sum, file) => sum + file.hunks.reduce((count, hunk) => count + hunk.additionLines, 0), 0),
        removedLines: files.reduce((sum, file) => sum + file.hunks.reduce((count, hunk) => count + hunk.deletionLines, 0), 0),
      }
    }
  }, [filePath, newContent, oldContent, patch])

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-app)]">
      <div className="flex items-center gap-3 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--lume-text-secondary)]">{filePath}</span>
        <span className="shrink-0 tabular-nums text-[var(--lume-success)]">+{diff.addedLines}</span>
        <span className="shrink-0 tabular-nums text-[var(--lume-danger)]">-{diff.removedLines}</span>
      </div>
      <PierreDiffView
        patch={diff.patch}
        oldContent={oldContent}
        newContent={newContent}
        filePath={filePath}
        compact
        disableHeader
        className="max-h-96"
      />
    </div>
  )
}
