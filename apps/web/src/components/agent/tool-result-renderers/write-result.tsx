import { CheckCircle } from 'lucide-react'

interface Props { input: Record<string, unknown>; result?: unknown }

export function WriteResult({ input, result }: Props) {
  // data.lines 恒有（write 工具返回）；_meta.file ±行数有则叠加（前后缀法口径，见 sdk line-change-stats）
  const data = (result ?? null) as Record<string, unknown> | null
  const lines = typeof data?.lines === 'number' ? data.lines : undefined
  const metaFile = (data?._meta ?? data?.meta) as Record<string, unknown> | undefined
  const added = typeof metaFile?.linesAdded === 'number' ? metaFile.linesAdded : undefined
  const removed = typeof metaFile?.linesRemoved === 'number' ? metaFile.linesRemoved : undefined
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-green-600 dark:text-green-400">
      <CheckCircle size={14} />
      <span className="font-mono text-[12px]">{String(input.file_path ?? '')}</span>
      {lines !== undefined && <span className="text-[12px] text-[var(--lume-text-muted)]">{lines} 行</span>}
      {(added !== undefined || removed !== undefined) && (
        <span className="font-mono text-[12px]">
          {added !== undefined && added > 0 && <span className="text-green-600 dark:text-green-400">+{added}</span>}
          {added !== undefined && removed !== undefined && added > 0 && removed > 0 && <span>{' '}</span>}
          {removed !== undefined && removed > 0 && <span className="text-[var(--lume-danger)]">-{removed}</span>}
        </span>
      )}
    </div>
  )
}
