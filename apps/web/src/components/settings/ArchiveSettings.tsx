import * as React from 'react'
import {
  ChevronRight,
  Clock3,
  Loader2,
  RotateCcw,
  Trash,
  Trash2,
} from 'lucide-react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type { AgentThreadMeta } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { cn } from '@/lib/utils'
import { agentWorkspacesAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

type View = 'archive' | 'trash'

const TRASH_RETENTION_DAYS = 30
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

function getDaysRemaining(trashedAt: number): number {
  const elapsed = Date.now() - trashedAt
  return Math.max(0, Math.ceil((TRASH_RETENTION_MS - elapsed) / (24 * 60 * 60 * 1000)))
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function ArchiveSettings({ initialView }: { initialView?: 'archive' | 'trash' }) {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [view, setView] = React.useState<View>(initialView ?? 'archive')
  const [archivedThreads, setArchivedThreads] = React.useState<AgentThreadMeta[]>([])
  const [trashedThreads, setTrashedThreads] = React.useState<AgentThreadMeta[]>([])
  const [loading, setLoading] = React.useState(true)

  const [confirmState, setConfirmState] = React.useState<{
    open: boolean
    title: string
    description: string
    confirmLabel: string
    destructive: boolean
    onConfirm: () => void
  }>({ open: false, title: '', description: '', confirmLabel: '确认', destructive: false, onConfirm: () => {} })

  const loadData = React.useCallback(async () => {
    try {
      const [archived, trashed] = await Promise.all([
        sidecarCall<AgentThreadMeta[]>(AGENT_IPC_CHANNELS.LIST_ARCHIVED_THREADS, {}),
        sidecarCall<AgentThreadMeta[]>(AGENT_IPC_CHANNELS.LIST_TRASHED_THREADS, {}),
      ])
      setArchivedThreads(Array.isArray(archived) ? archived : [])
      setTrashedThreads(Array.isArray(trashed) ? trashed : [])
    } catch (error) {
      console.error('[ArchiveSettings] 加载失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadData()
  }, [loadData])

  // ---- Archive actions ----

  const handleRestore = async (threadId: string) => {
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.RESTORE_THREAD, { threadId })
      toast.success('已恢复')
      void loadData()
    } catch (error) {
      console.error('[ArchiveSettings] 恢复失败:', error)
      toast.error('恢复失败')
    }
  }

  const handleTrash = async (threadId: string) => {
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.TRASH_THREAD, { threadId })
      toast.success('已移入回收站')
      void loadData()
    } catch (error) {
      console.error('[ArchiveSettings] 移入回收站失败:', error)
      toast.error('操作失败')
    }
  }

  // ---- Trash actions ----

  const handleRestoreFromTrash = async (threadId: string) => {
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.RESTORE_THREAD_FROM_TRASH, { threadId })
      toast.success('已恢复到归档')
      void loadData()
    } catch (error) {
      console.error('[ArchiveSettings] 恢复失败:', error)
      toast.error('恢复失败')
    }
  }

  const handlePermanentDelete = (thread: AgentThreadMeta) => {
    setConfirmState({
      open: true,
      title: '永久删除',
      description: `确认永久删除会话「${thread.title}」？此操作不可撤销。`,
      confirmLabel: '永久删除',
      destructive: true,
      onConfirm: async () => {
        try {
          await sidecarCall(AGENT_IPC_CHANNELS.PERMANENTLY_DELETE_THREAD, { threadId: thread.id })
          toast.success('已永久删除')
          void loadData()
        } catch (error) {
          console.error('[ArchiveSettings] 永久删除失败:', error)
          toast.error('删除失败')
        }
      },
    })
  }

  const handleEmptyTrash = () => {
    if (trashedThreads.length === 0) return
    setConfirmState({
      open: true,
      title: '清空回收站',
      description: `确认清空回收站中的 ${trashedThreads.length} 个会话？此操作不可撤销。`,
      confirmLabel: '清空',
      destructive: true,
      onConfirm: async () => {
        try {
          await Promise.all(
            trashedThreads.map((t) => sidecarCall(AGENT_IPC_CHANNELS.PERMANENTLY_DELETE_THREAD, { threadId: t.id })),
          )
          toast.success('回收站已清空')
          void loadData()
        } catch (error) {
          console.error('[ArchiveSettings] 清空回收站失败:', error)
          toast.error('清空失败')
        }
      },
    })
  }

  // ---- Helpers ----

  const getWorkspaceName = (workspaceId?: string) => {
    if (!workspaceId) return '未分配'
    return workspaces.find((w) => w.id === workspaceId)?.name ?? '未知工作区'
  }

  const archivedByWorkspace = React.useMemo(() => {
    const groups = new Map<string, AgentThreadMeta[]>()
    for (const thread of archivedThreads) {
      const key = thread.workspaceId ?? '__unassigned__'
      const group = groups.get(key) ?? []
      group.push(thread)
      groups.set(key, group)
    }
    return groups
  }, [archivedThreads])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-[var(--text-3)]">
        <Loader2 size={20} className="animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Sub-view: Archive or Trash */}
      {view === 'archive' ? (
        <ArchiveView
          archivedByWorkspace={archivedByWorkspace}
          trashedCount={trashedThreads.length}
          getWorkspaceName={getWorkspaceName}
          onRestore={handleRestore}
          onTrash={handleTrash}
          onOpenTrash={() => setView('trash')}
        />
      ) : (
        <TrashView
          trashedThreads={trashedThreads}
          onRestore={handleRestoreFromTrash}
          onPermanentDelete={handlePermanentDelete}
          onEmptyTrash={handleEmptyTrash}
          onBack={() => setView('archive')}
        />
      )}

      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => setConfirmState((prev) => ({ ...prev, open }))}
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel={confirmState.confirmLabel}
        destructive={confirmState.destructive}
        onConfirm={confirmState.onConfirm}
      />
    </div>
  )
}

// ===== Archive View =====

function ArchiveView({
  archivedByWorkspace,
  trashedCount,
  getWorkspaceName,
  onRestore,
  onTrash,
  onOpenTrash,
}: {
  archivedByWorkspace: Map<string, AgentThreadMeta[]>
  trashedCount: number
  getWorkspaceName: (id?: string) => string
  onRestore: (id: string) => void
  onTrash: (id: string) => void
  onOpenTrash: () => void
}) {
  const totalArchived = [...archivedByWorkspace.values()].reduce((sum, g) => sum + g.length, 0)

  return (
    <>
      <Section
        title="归档会话"
        extra={
          <button
            type="button"
            onClick={onOpenTrash}
            className="flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <Trash size={13} />
            回收站{trashedCount > 0 ? ` (${trashedCount})` : ''}
          </button>
        }
      >
        {totalArchived === 0 ? (
          <EmptyState text="暂无归档会话" />
        ) : (
          [...archivedByWorkspace.entries()].map(([workspaceKey, threads]) => (
            <div key={workspaceKey} className="mb-4 last:mb-0">
              <div className="mb-1.5 px-1 text-[12px] font-medium uppercase tracking-wide text-[var(--text-3)]">
                {getWorkspaceName(workspaceKey === '__unassigned__' ? undefined : workspaceKey)}
              </div>
              <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)]">
                {threads.map((thread, i) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    showBorder={i < threads.length - 1}
                    subtitle={formatDate(thread.updatedAt)}
                  >
                    <ActionButton icon={RotateCcw} label="恢复" onClick={() => onRestore(thread.id)} />
                    <ActionButton icon={Trash2} label="移入回收站" onClick={() => onTrash(thread.id)} variant="danger" />
                  </ThreadRow>
                ))}
              </div>
            </div>
          ))
        )}
      </Section>
    </>
  )
}

// ===== Trash View =====

function TrashView({
  trashedThreads,
  onRestore,
  onPermanentDelete,
  onEmptyTrash,
  onBack,
}: {
  trashedThreads: AgentThreadMeta[]
  onRestore: (id: string) => void
  onPermanentDelete: (thread: AgentThreadMeta) => void
  onEmptyTrash: () => void
  onBack: () => void
}) {
  return (
    <>
      {/* Back button + header */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-2)] hover:text-[var(--text-1)]"
        >
          <ChevronRight size={14} className="rotate-180" />
          返回归档
        </button>
        {trashedThreads.length > 0 && (
          <button
            type="button"
            onClick={onEmptyTrash}
            className="flex items-center gap-1.5 rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-[var(--danger)] hover:bg-[var(--surface-2)]"
          >
            <Trash2 size={13} />
            清空回收站
          </button>
        )}
      </div>

      {trashedThreads.length === 0 ? (
        <EmptyState text="回收站为空" />
      ) : (
        <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)]">
          {trashedThreads.map((thread, i) => {
            const days = thread.trashedAt ? getDaysRemaining(thread.trashedAt) : TRASH_RETENTION_DAYS
            return (
              <ThreadRow
                key={thread.id}
                thread={thread}
                showBorder={i < trashedThreads.length - 1}
                subtitle={formatDate(thread.updatedAt)}
                badge={`${days} 天后清理`}
              >
                <ActionButton icon={RotateCcw} label="恢复到归档" onClick={() => onRestore(thread.id)} />
                <ActionButton icon={Trash2} label="永久删除" onClick={() => onPermanentDelete(thread)} variant="danger" />
              </ThreadRow>
            )
          })}
        </div>
      )}
    </>
  )
}

// ===== Shared sub-components =====

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-[var(--text-1)]">{title}</h3>
        {extra}
      </div>
      {children}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] py-10 text-[13px] text-[var(--text-3)]">
      {text}
    </div>
  )
}

function ThreadRow({
  thread,
  showBorder,
  subtitle,
  badge,
  children,
}: {
  thread: AgentThreadMeta
  showBorder: boolean
  subtitle?: string
  badge?: string
  children: React.ReactNode
}) {
  const [hovered, setHovered] = React.useState(false)
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 transition-colors',
        showBorder && 'border-b border-[var(--border)]',
        hovered && 'bg-[var(--surface-2)]',
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-[var(--text-1)]">{thread.title}</div>
        <div className="flex items-center gap-2 text-[12px] text-[var(--text-3)]">
          {subtitle && <span>{subtitle}</span>}
          {badge && (
            <span className="flex items-center gap-1 rounded-[4px] bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px]">
              <Clock3 size={10} />
              {badge}
            </span>
          )}
        </div>
      </div>
      <div className={cn('flex items-center gap-1', !hovered && 'invisible')}>
        {children}
      </div>
    </div>
  )
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  variant = 'default',
}: {
  icon: React.ElementType
  label: string
  onClick: () => void
  variant?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors',
        variant === 'danger'
          ? 'text-[var(--danger)] hover:bg-[color-mix(in_oklab,var(--danger)_10%,transparent)]'
          : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]',
      )}
    >
      <Icon size={13} />
      {label}
    </button>
  )
}
