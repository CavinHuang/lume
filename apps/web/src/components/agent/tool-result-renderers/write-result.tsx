import { CheckCircle } from 'lucide-react'

interface Props { input: Record<string, unknown>; result?: unknown }

export function WriteResult({ input, result }: Props) {
  // result 即 write 工具 data 对象（content 反序列化结果）；±行为前后缀裁剪法
  // 口径（见 sdk line-change-stats），与 turn 卡 changeSet(git 权威) 并读时以后者为准
  const data = (result ?? null) as Record<string, unknown> | null
  const lines = typeof data?.lines === 'number' ? data.lines : undefined
  const added = typeof data?.linesAdded === 'number' ? data.linesAdded : undefined
  const removed = typeof data?.linesRemoved === 'number' ? data.linesRemoved : undefined
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-body text-green-600 dark:text-green-400">
      <CheckCircle size={14} />
      <span className="font-mono text-caption">{String(input.file_path ?? '')}</span>
      {lines !== undefined && <span className="text-caption text-[var(--lume-text-muted)]">共 {lines} 行</span>}
      {(added !== undefined || removed !== undefined) && (
        <span className="font-mono text-caption">
          {added !== undefined && added > 0 && <span>+{added}</span>}
          {added !== undefined && removed !== undefined && added > 0 && removed > 0 && <span>{' '}</span>}
          {removed !== undefined && removed > 0 && <span className="text-[var(--lume-danger)]">-{removed}</span>}
        </span>
      )}
    </div>
  )
}
