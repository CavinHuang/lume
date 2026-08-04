import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AlertTriangle, CornerDownRight, Edit3, GripVertical, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import type { AgentFollowUpMode, AgentMessageQueueSnapshot, AgentQueuedMessage } from '@lume/shared'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { summarizeQueuedMessage } from './agent-message-queue-summary'

interface AgentMessageQueueListProps {
  snapshot: AgentMessageQueueSnapshot
  /** 拖拽结束产出新的 visible 项 id 顺序;父级做乐观更新 + IPC。 */
  onReorder: (orderedIds: string[]) => void
  onRemove: (queuedMessageId: string) => void
  onEdit: (queuedMessageId: string) => void
  onPromoteToGuidance: (queuedMessageId: string) => void
  onRetry?: (queuedMessageId: string) => void
  interrupted?: boolean
  onResume?: () => void
  followUpMode?: AgentFollowUpMode
  onFollowUpModeChange?: (mode: AgentFollowUpMode) => void
}

export function AgentMessageQueueList({
  snapshot,
  onReorder,
  onRemove,
  onEdit,
  onPromoteToGuidance,
  onRetry,
  interrupted = false,
  onResume,
  followUpMode,
  onFollowUpModeChange,
}: AgentMessageQueueListProps) {
  const visibleQueuedMessages = snapshot.queuedMessages.filter((item) => !item.internal)
  const hasQueue = visibleQueuedMessages.length > 0
  const hasGuidance = snapshot.pendingGuidance.length > 0
  const itemIds = visibleQueuedMessages.map((m) => m.id)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  if (!hasQueue && !hasGuidance) return null

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = itemIds.indexOf(String(active.id))
    const newIndex = itemIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    const next = [...itemIds]
    const [moved] = next.splice(oldIndex, 1)
    next.splice(newIndex, 0, moved!)
    onReorder(next)
  }

  return (
    <div className="-mx-4 -mt-3 mb-3 max-h-[30dvh] overflow-y-auto border-b border-[color:color-mix(in_oklab,var(--border-strong)_34%,transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {interrupted && hasQueue && (
        <div className="flex items-center justify-between gap-2 border-b border-[color:color-mix(in_oklab,var(--lume-warning)_30%,transparent)] px-4 py-2 text-[12px] text-[var(--lume-warning)]">
          <span>队列已暂停(你中断了当前输出)</span>
          <Button variant="ghost" type="button" onClick={onResume} className="h-7 px-2 text-[12px] text-[var(--lume-warning)]">
            继续
          </Button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <AnimatePresence initial={false}>
            {visibleQueuedMessages.map((item) => (
              <QueuedMessageRow
                key={item.id}
                item={item}
                onRemove={onRemove}
                onEdit={onEdit}
                onPromoteToGuidance={onPromoteToGuidance}
                onRetry={onRetry}
                followUpMode={followUpMode}
                onFollowUpModeChange={onFollowUpModeChange}
              />
            ))}
          </AnimatePresence>
        </SortableContext>
      </DndContext>
      {hasGuidance && snapshot.pendingGuidance.map((item) => (
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
  )
}

function QueuedMessageRow({
  item,
  onRemove,
  onEdit,
  onPromoteToGuidance,
  onRetry,
  followUpMode,
  onFollowUpModeChange,
}: {
  item: AgentQueuedMessage
  onRemove: (id: string) => void
  onEdit: (id: string) => void
  onPromoteToGuidance: (id: string) => void
  onRetry?: (id: string) => void
  followUpMode?: AgentFollowUpMode
  onFollowUpModeChange?: (mode: AgentFollowUpMode) => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id })
  const [menuOpen, setMenuOpen] = useState(false)
  const canPromote = item.status === 'queued' && item.text.trim().length > 0
  const blocked = item.status === 'blocked'

  return (
    <motion.div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: isDragging ? 0.6 : 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.18 }}
      className={cn(
        'group relative flex h-11 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border-strong)_28%,transparent)] px-4 text-[14px] text-[var(--text-2)] transition-colors last:border-b-0 hover:bg-[color:color-mix(in_oklab,var(--surface-2)_62%,transparent)]',
        isDragging && 'z-10',
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        disabled={item.status === 'validating'}
        aria-label="拖拽排序"
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab text-[var(--text-3)] active:cursor-grabbing"
      >
        <GripVertical size={15} strokeWidth={2} />
      </button>
      {blocked && (
        <span
          className="shrink-0 text-[var(--lume-warning)]"
          title={item.blockedReason ? `发送失败:${item.blockedReason}。重试、编辑或删除以继续队列。` : '重试、编辑或删除以继续队列'}
        >
          <AlertTriangle size={14} strokeWidth={2} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-2)]">{summarizeQueuedMessage(item)}</span>
      {blocked && (
        <Button
          variant="ghost"
          type="button"
          onClick={() => onRetry?.(item.id)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,transparent)] px-3 text-[12px] font-medium text-[var(--lume-warning)] transition-colors hover:text-[var(--lume-warning)]"
          title={item.blockedReason ? `发送失败:${item.blockedReason}` : '重试发送'}
        >
          <RotateCcw size={13} strokeWidth={2} />
          重试
        </Button>
      )}
      <Button
        variant="ghost"
        type="button"
        onClick={() => onPromoteToGuidance(item.id)}
        disabled={!canPromote}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-[color:color-mix(in_oklab,var(--surface-3)_76%,transparent)] px-3 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:text-[var(--text-1)]"
        title={canPromote ? '在下次工具调用前发送(引导)' : '请先输入消息文本'}
      >
        <CornerDownRight size={14} strokeWidth={2} />
        引导
      </Button>
      <Button
        variant="ghost"
        type="button"
        onClick={() => onRemove(item.id)}
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
              onClick={() => { setMenuOpen(false); onEdit(item.id) }}
              className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_68%,transparent)]"
            >
              <Edit3 size={14} strokeWidth={2} className="text-[var(--text-3)]" />
              编辑消息
            </Button>
            {onFollowUpModeChange && (
              <Button
                variant="ghost"
                type="button"
                onClick={() => { setMenuOpen(false); onFollowUpModeChange('steer') }}
                className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_68%,transparent)]"
              >
                <CornerDownRight size={14} strokeWidth={2} className="text-[var(--text-3)]" />
                关闭排队
              </Button>
            )}
            {onFollowUpModeChange && (
              <>
                <div className="my-1 border-t border-[color:color-mix(in_oklab,var(--border-strong)_34%,transparent)]" />
                {(['queue', 'steer', 'interrupt'] as const).map((mode) => (
                  <Button
                    key={mode}
                    variant="ghost"
                    type="button"
                    onClick={() => { setMenuOpen(false); onFollowUpModeChange(mode) }}
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13px] font-medium text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_68%,transparent)]"
                  >
                    {followUpMode === mode ? '●' : '○'} {mode === 'queue' ? '排队模式' : mode === 'steer' ? '引导模式' : '中断模式'}
                  </Button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </motion.div>
  )
}
