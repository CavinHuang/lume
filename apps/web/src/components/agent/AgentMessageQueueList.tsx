import { CornerDownRight, GripVertical, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { AgentMessageQueueSnapshot, AgentQueuedMessage } from '@lume/shared'
import { cn } from '@/lib/utils'

interface AgentMessageQueueListProps {
  snapshot: AgentMessageQueueSnapshot
  onReorder: (draggedId: string, targetId: string) => void
  onRemove: (queuedMessageId: string) => void
  onPromoteToGuidance: (queuedMessageId: string) => void
}

export function AgentMessageQueueList({
  snapshot,
  onReorder,
  onRemove,
  onPromoteToGuidance,
}: AgentMessageQueueListProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const hasQueue = snapshot.queuedMessages.length > 0
  const hasGuidance = snapshot.pendingGuidance.length > 0
  if (!hasQueue && !hasGuidance) return null

  return (
    <div className="mb-2 space-y-1.5 px-2">
      {hasGuidance && (
        <div className="space-y-1">
          {snapshot.pendingGuidance.map((item) => (
            <div
              key={item.id}
              className="flex min-h-9 items-center gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_7%,transparent)] px-2.5 text-[12px] text-[var(--text-2)]"
            >
              <CornerDownRight size={14} className="shrink-0 text-[var(--brand)]" />
              <span className="shrink-0 font-medium text-[var(--text-1)]">引导待发送</span>
              <span className="min-w-0 truncate">{item.text}</span>
            </div>
          ))}
        </div>
      )}
      {snapshot.queuedMessages.map((item) => (
        <QueuedMessageRow
          key={item.id}
          item={item}
          dragging={draggedId === item.id}
          onDragStart={() => setDraggedId(item.id)}
          onDragEnd={() => setDraggedId(null)}
          onDrop={() => {
            if (draggedId) onReorder(draggedId, item.id)
            setDraggedId(null)
          }}
          onRemove={() => onRemove(item.id)}
          onPromoteToGuidance={() => onPromoteToGuidance(item.id)}
        />
      ))}
    </div>
  )
}

function QueuedMessageRow({
  item,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onRemove,
  onPromoteToGuidance,
}: {
  item: AgentQueuedMessage
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: () => void
  onRemove: () => void
  onPromoteToGuidance: () => void
}) {
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group flex min-h-9 items-center gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_90%,transparent)] px-2 text-[12px] text-[var(--text-2)] transition-colors',
        dragging && 'opacity-60',
      )}
    >
      <GripVertical size={14} className="shrink-0 cursor-grab text-[var(--text-3)]" />
      <span className="min-w-0 flex-1 truncate">{item.text}</span>
      <button
        type="button"
        onClick={onPromoteToGuidance}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-[color:color-mix(in_oklab,var(--surface-3)_70%,transparent)] px-2 text-[11px] font-medium text-[var(--text-2)] transition-colors hover:text-[var(--text-1)]"
        title="在下次工具调用前发送"
      >
        <CornerDownRight size={13} />
        引导
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_70%,transparent)] hover:text-[var(--text-1)]"
        title="删除排队消息"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}
