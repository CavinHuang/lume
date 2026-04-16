import { CheckCircle } from 'lucide-react'

interface Props { input: Record<string, unknown>; result?: unknown }

export function WriteResult({ input }: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-green-600 dark:text-green-400">
      <CheckCircle size={14} />
      <span className="font-mono text-[12px]">{String(input.file_path ?? '')}</span>
    </div>
  )
}
