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
      meta: string
    }>
  }
  onOpen: (threadId: string) => void
}

export function RecentThreads({ panel, onOpen }: RecentThreadsProps) {
  return (
    <section className="flex h-full flex-col rounded-[1.7rem] border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-1)_94%,transparent),color-mix(in_oklab,var(--surface-2)_84%,transparent))] p-5 shadow-[0_20px_44px_-38px_hsl(var(--shadow-panel)/0.35)]">
      <header className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-3)]">
          {panel.title}
        </p>
        <p className="mt-1 text-[13px] leading-6 text-[var(--text-2)]">{panel.subtitle}</p>
      </header>

      <div className="flex flex-1 flex-col gap-2">
        {panel.items.length > 0 ? (
          panel.items.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => onOpen(thread.id)}
              className="group flex items-center gap-3 rounded-[1.15rem] border border-transparent bg-[color:color-mix(in_oklab,var(--surface-2)_76%,transparent)] px-3.5 py-3 text-left transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-3)_72%,transparent)]"
            >
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[color:color-mix(in_oklab,var(--brand)_78%,white)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--text-1)]">
                  {thread.title}
                </span>
                <span className="mt-1 block text-[12px] text-[var(--text-3)]">{thread.meta}</span>
              </span>
              <span className="text-[12px] text-[var(--text-3)] transition-transform group-hover:translate-x-0.5">
                打开
              </span>
            </button>
          ))
        ) : (
          <div className="flex flex-1 items-center rounded-[1.2rem] border border-dashed border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_72%,transparent)] px-4 py-5 text-[13px] leading-6 text-[var(--text-2)]">
            {panel.emptyLabel}
          </div>
        )}
      </div>
    </section>
  )
}
