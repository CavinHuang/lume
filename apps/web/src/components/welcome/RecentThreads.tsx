import { ArrowRight, MessageCircle } from 'lucide-react'

interface RecentThreadsProps {
  panel: {
    id: 'recent-threads'
    title: string
    subtitle: string
    emptyLabel: string
    items: Array<{
      kind: 'thread'
      id: string
      title: string
      description: string
      meta: string
    }>
  }
  onOpen: (threadId: string) => void
}

export function RecentThreads({ panel, onOpen }: RecentThreadsProps) {
  return (
    <section className="flex h-full min-h-[190px] flex-col rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_50%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] p-4 shadow-[0_16px_34px_-32px_hsl(var(--shadow-panel)/0.34)]">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-[var(--text-1)]">
            {panel.title}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-[var(--brand)] transition-colors hover:text-[color:color-mix(in_oklab,var(--brand)_72%,black)]"
        >
          查看全部 ({panel.items.length})
          <ArrowRight size={13} />
        </button>
      </header>

      <div className="flex flex-1 flex-col">
        {panel.items.length > 0 ? (
          panel.items.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => onOpen(thread.id)}
              className="group flex items-center gap-3 border-b border-[color:color-mix(in_oklab,var(--border-strong)_34%,transparent)] py-2.5 text-left transition-colors last:border-b-0 hover:bg-[color:color-mix(in_oklab,var(--surface-2)_55%,transparent)]"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_92%,transparent)] text-[var(--text-2)]">
                <MessageCircle size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--text-1)]">
                  {thread.title}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-[var(--text-3)]">{thread.description}</span>
              </span>
              <span className="shrink-0 text-[12px] text-[var(--text-3)]">
                {thread.meta}
              </span>
            </button>
          ))
        ) : (
          <div className="flex flex-1 items-center rounded-lg border border-dashed border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_62%,transparent)] px-4 py-5 text-[13px] leading-6 text-[var(--text-2)]">
            {panel.emptyLabel}
          </div>
        )}
      </div>
    </section>
  )
}
