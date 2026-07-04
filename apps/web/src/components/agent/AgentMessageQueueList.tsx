import { CornerDownRight, Edit3, GripVertical, MoreHorizontal, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import type { AgentMessageQueueSnapshot, AgentQueuedMessage } from '@lume/shared'
import { cn } from '@/lib/utils'

import { Button } from '@/components/ui/button'
type QueueDropPlacement = 'before' | 'after'

interface AgentMessageQueueListProps {
  snapshot: AgentMessageQueueSnapshot
  onReorder: (draggedId: string, targetId: string, placement: QueueDropPlacement) => void
  onRemove: (queuedMessageId: string) => void
  onEdit: (queuedMessageId: string) => void
  onPromoteToGuidance: (queuedMessageId: string) => void
}

export function AgentMessageQueueList({
  snapshot,
  onReorder,
  onRemove,
  onEdit,
  onPromoteToGuidance,
}: AgentMessageQueueListProps) {
  const draggedIdRef = useRef<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const hasQueue = snapshot.queuedMessages.length > 0
  const hasGuidance = snapshot.pendingGuidance.length > 0
  if (!hasQueue && !hasGuidance) return null

  return (
    <div className="-mx-4 -mt-3 mb-3 border-b border-[color:color-mix(in_oklab,var(--border-strong)_34%,transparent)]">
      {hasGuidance && (
        <div>
          {snapshot.pendingGuidance.map((item) => (
            <div
              key={item.id}
              className="flex h-11 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_28%,transparent)] px-4 text-[13px] text-[var(--text-2)]"
            >
              <CornerDownRight size={15} strokeWidth={2} className="shrink-0 text-[var(--text-3)]" />
              <span className="shrink-0 font-medium text-[var(--text-2)]">引导</span>
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
          onDragStart={() => {
            draggedIdRef.current = item.id
            setDraggedId(item.id)
          }}
          onDragEnd={() => {
            draggedIdRef.current = null
            setDraggedId(null)
          }}
          onDrop={(draggedIdFromEvent, placement) => {
            const nextDraggedId = draggedIdFromEvent || draggedIdRef.current
            if (nextDraggedId) onReorder(nextDraggedId, item.id, placement)
            draggedIdRef.current = null
            setDraggedId(null)
          }}
          onRemove={() => onRemove(item.id)}
          onEdit={() => onEdit(item.id)}
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
  onEdit,
  onPromoteToGuidance,
}: {
  item: AgentQueuedMessage
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: (draggedId: string, placement: QueueDropPlacement) => void
  onRemove: () => void
  onEdit: () => void
  onPromoteToGuidance: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', item.id)
        onDragStart()
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const placement: QueueDropPlacement = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
        onDrop(event.dataTransfer.getData('text/plain'), placement)
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative flex h-11 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_28%,transparent)] px-4 text-[14px] text-[var(--text-2)] transition-colors last:border-b-0 hover:bg-[color:color-mix(in_oklab,var(--surface-2)_62%,transparent)]',
        dragging && 'bg-[color:color-mix(in_oklab,var(--surface-3)_70%,transparent)] opacity-70',
      )}
    >
      <GripVertical size={15} strokeWidth={2} className="shrink-0 cursor-grab text-[var(--text-3)]" />
      <CornerDownRight size={15} strokeWidth={2} className="shrink-0 text-[var(--text-3)]" />
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-2)]">{item.text}</span>
      <Button
                variant="ghost"
        type="button"
        onClick={onPromoteToGuidance}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[color:color-mix(in_oklab,var(--surface-3)_76%,transparent)] px-3 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:text-[var(--text-1)]"
        title="在下次工具调用前发送"
      >
        <CornerDownRight size={14} strokeWidth={2} />
        引导
      </Button>
      <Button
                variant="ghost"
        type="button"
        onClick={onRemove}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_70%,transparent)] hover:text-[var(--text-1)]"
        title="删除排队消息"
      >
        <Trash2 size={14} strokeWidth={2} />
      </Button>
      <Button
                variant="ghost"
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--surface-3)_72%,transparent)] text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
        title="更多"
      >
        <MoreHorizontal size={15} strokeWidth={2.1} />
      </Button>
      {menuOpen && (
        <>
          <Button
            variant="ghost"
            type="button"
            aria-label="关闭菜单"
            className="fixed inset-0 z-10 h-auto w-auto cursor-default bg-transparent p-0 hover:bg-transparent"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute right-4 top-9 z-20 min-w-[132px] overflow-hidden rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] py-1 shadow-[0_14px_42px_rgba(28,32,58,0.16)]">
            <Button
                variant="ghost"
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onEdit()
              }}
              className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_68%,transparent)]"
            >
              <Edit3 size={14} strokeWidth={2} className="text-[var(--text-3)]" />
              编辑消息
            </Button>
            <Button
                variant="ghost"
              type="button"
              onClick={() => {
                setMenuOpen(false)
                onRemove()
              }}
              className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_68%,transparent)]"
            >
              <CornerDownRight size={14} strokeWidth={2} className="text-[var(--text-3)]" />
              关闭排队
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
