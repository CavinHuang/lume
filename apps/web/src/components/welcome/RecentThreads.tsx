import type { AgentThreadMeta } from '@lume/shared'

interface RecentThreadsProps {
  threads: AgentThreadMeta[]
  onOpen: (thread: AgentThreadMeta) => void
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function RecentThreads({ threads, onOpen }: RecentThreadsProps) {
  if (threads.length === 0) return null

  return (
    <div className="w-full mt-6">
      <div className="text-[11px] font-medium text-foreground/40 mb-2">最近对话</div>
      <div className="flex flex-col gap-1">
        {threads.map((thread) => (
          <button
            key={thread.id}
            onClick={() => onOpen(thread)}
            className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-muted/30 transition-colors text-left"
          >
            <span className="text-[13px] text-foreground/80 truncate flex-1">{thread.title}</span>
            <span className="text-[11px] text-foreground/30 flex-shrink-0 ml-2">{relativeTime(thread.updatedAt)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
