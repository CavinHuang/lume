import { ChevronDown, ChevronRight, CornerDownRight, Edit3, GripVertical, MoreHorizontal, Trash2 } from 'lucide-react'
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
  const [expanded, setExpanded] = useState(false)
  const hasQueue = snapshot.queuedMessages.length > 0
  const hasGuidance = snapshot.pendingGuidance.length > 0
  if (!hasQueue && !hasGuidance) return null

  return (
    <div className="-mx-4 -mt-3 mb-3 border-b border-[color:color-mix(in_oklab,var(--border-strong)_34%,transparent)]">
      <Button
        variant="ghost"
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex h-9 w-full items-center justify-start gap-2 rounded-none px-4 text-xs text-[var(--lume-text-secondary)]"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {snapshot.queuedMessages.length} 条排队消息
        {hasGuidance ? ` · ${snapshot.pendingGuidance.length} 条引导` : ''}
      </Button>
      {expanded && hasGuidance && (
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
      {expanded && snapshot.queuedMessages.map((item) => (
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
  const canPromote = item.status === 'queued'
    && !item.messageAttachments?.length
    && !item.messageParts?.some((part) => part.type === 'capability_ref')
    && !item.desktopContextSnapshotId
    && item.text.trim().length > 0
  return (
    <div
      draggable={item.status !== 'validating'}
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
      {item.status !== 'queued' ? (
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
            item.status === 'blocked'
              ? 'bg-[color:color-mix(in_oklab,var(--lume-danger)_10%,transparent)] text-[var(--lume-danger)]'
              : 'bg-[var(--lume-accent-soft)] text-[var(--lume-accent)]',
          )}
          title={item.blockedReason}
        >
          {item.status === 'blocked' ? '已暂停' : '校验中'}
        </span>
      ) : null}
      <Button
                variant="ghost"
        type="button"
        onClick={onPromoteToGuidance}
        disabled={!canPromote}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[color:color-mix(in_oklab,var(--surface-3)_76%,transparent)] px-3 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:text-[var(--text-1)]"
        title={canPromote ? '在下次工具调用前发送' : '包含附件、能力引用或桌面上下文的消息不能提升为引导'}
      >
        <CornerDownRight size={14} strokeWidth={2} />
        引导
      </Button>
      <Button
                variant="ghost"
        type="button"
        onClick={onRemove}
        disabled={item.status === 'validating'}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-3)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_70%,transparent)] hover:text-[var(--text-1)]"
        title="删除排队消息"
      >
        <Trash2 size={14} strokeWidth={2} />
      </Button>
      <Button
                variant="ghost"
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        disabled={item.status === 'validating'}
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
