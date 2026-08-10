import { useCallback, useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  Inbox,
  Sparkles,
  Wand2,
  Brain,
  History,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  suggestionsVersionAtom,
  memoryCenterDeepLinkAtom,
  memoryCenterVersionAtom,
} from '@/atoms'
import { Button } from '@/components/ui/button'
import { getMemorySettingsSnapshot, resolveMemoryPending } from '@/lib/desktop-api/memory-center'
import {
  actOnSuggestion,
  deleteSuggestion,
  getSuggestionStats,
  listSuggestions,
  runSuggestionAnalysis,
} from '@/lib/desktop-api/suggestion'
import { cn } from '@/lib/utils'
import { MemoryLibraryView } from './MemoryLibraryView'
import { MemoryAttentionView } from './MemoryAttentionView'
import { MemoryInsightsView } from './MemoryInsightsView'
import { MemoryActivityView } from './MemoryActivityView'
import { normalizeMemoryCenterLink } from '@/components/memory/memory-center-state'
import type {
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot,
  SuggestionFeedback,
  SuggestionRecord,
  SuggestionStats,
} from '@lume/shared'

/**
 * 记忆与洞察中心：聚合待处理记忆、长期记忆、关于我、建议与活动。
 *
 * 数据并发拉取（Promise.all），任一失败不阻塞其它 section；
 * 订阅 suggestionsVersionAtom → sidecar 推送 CHANGED 时 bump → 触发重拉。
 */
export interface MemoryInsightsHubProps {
  /** 兼容旧调用方；记忆管理已经收敛到当前中心。 */
  onOpenMemorySettings?: () => void
}

export function MemoryInsightsHub(_props: MemoryInsightsHubProps) {
  const version = useAtomValue(suggestionsVersionAtom)
  const memoryVersion = useAtomValue(memoryCenterVersionAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceSlug =
    workspaces.find((w) => w.id === currentWorkspaceId)?.slug ??
    workspaces[0]?.slug

  const [suggestions, setSuggestions] = useState<SuggestionRecord[]>([])
  const [snapshot, setSnapshot] = useState<MemorySettingsSnapshot | null>(null)
  const [stats, setStats] = useState<SuggestionStats | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [busyPendingId, setBusyPendingId] = useState<string | null>(null)
  const [deepLink, setDeepLink] = useAtom(memoryCenterDeepLinkAtom)
  const section = deepLink.section

  useEffect(() => {
    if (!workspaceSlug || deepLink.workspaceSlug === workspaceSlug) return
    setDeepLink(normalizeMemoryCenterLink(deepLink, workspaceSlug))
  }, [deepLink, setDeepLink, workspaceSlug])

  /**
   * 并发拉取独立数据源；每个源各自 catch → 失败仅降级为该 section 的空状态，
   * 不影响其它 section 展示（Promise.all + per-task catch 等价 allSettled 但更直白）。
   */
  const refresh = useCallback(async () => {
    await Promise.all([
      listSuggestions('suggested')
        .then(setSuggestions)
        .catch((err) => {
          console.error('[MemoryInsightsHub] listSuggestions failed', err)
        }),
      getSuggestionStats()
        .then(setStats)
        .catch((err) => {
          console.error('[MemoryInsightsHub] getSuggestionStats failed', err)
        }),
      workspaceSlug && (section === 'attention' || section === 'insights')
        ? getMemorySettingsSnapshot(workspaceSlug)
            .then(setSnapshot)
            .catch((err) => {
              console.error(
                '[MemoryInsightsHub] getMemorySettingsSnapshot failed',
                err,
              )
              setSnapshot(null)
            })
        : Promise.resolve(),
    ])
    if (!workspaceSlug) setSnapshot(null)
  }, [section, workspaceSlug])

  useEffect(() => {
    void refresh()
  }, [refresh, memoryVersion, version])

  const reloadSuggestions = useCallback(async () => {
    const [list, nextStats] = await Promise.all([
      listSuggestions('suggested'),
      getSuggestionStats().catch(() => null),
    ])
    setSuggestions(list)
    if (nextStats) setStats(nextStats)
  }, [])

  const analyze = async () => {
    setAnalyzing(true)
    try {
      const result = await runSuggestionAnalysis(workspaceSlug)
      toast.success(
        result.added > 0
          ? `分析完成，新增 ${result.added} 条建议`
          : '分析完成，暂无新建议',
      )
      await reloadSuggestions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '工作模式分析失败')
    } finally {
      setAnalyzing(false)
    }
  }

  const handleAct = async (id: number, feedback: SuggestionFeedback) => {
    setBusyId(id)
    try {
      await actOnSuggestion(id, feedback)
      await reloadSuggestions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '反馈失败')
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (id: number) => {
    setBusyId(id)
    try {
      await deleteSuggestion(id)
      await reloadSuggestions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  const handlePending = async (
    item: MemorySettingsPendingSummary,
    action: 'accept' | 'reject',
  ) => {
    if (!workspaceSlug) return
    setBusyPendingId(item.id)
    try {
      await resolveMemoryPending({ workspaceSlug, path: item.path, action })
      await refresh()
      toast.success(action === 'accept' ? '已接受候选记忆' : '已保留现有记忆')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '处理记忆失败')
    } finally {
      setBusyPendingId(null)
    }
  }

  const pendingItems = (snapshot?.pending ?? []).filter(
    (item) => item.status === 'open',
  )
  const pendingCount = snapshot?.counts.pending.total ?? pendingItems.length
  const memoryCount = snapshot?.counts.active ?? null
  const focusTotal = suggestions.length + pendingCount

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--lume-bg-app)]">
      <header className="shrink-0 px-6 pt-3 md:px-8 lg:px-10 lg:pt-4">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">记忆与洞察</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {focusTotal > 0 ? `${focusTotal} 件事需要处理` : '当前无需处理'}
            </p>
          </div>
          {(section === 'attention' || section === 'insights') && <Button onClick={analyze} disabled={analyzing} data-proactive-analyze>
            <Wand2 className={analyzing ? 'animate-spin' : undefined} size={16} />
            {analyzing ? '分析中…' : '分析工作模式'}
          </Button>}
        </div>
        <div className="lume-segmented mt-4 grid grid-cols-4 overflow-hidden">
          {([
            ['attention', '需要处理', Inbox],
            ['memory', '记忆', Brain],
            ['insights', '洞察', Sparkles],
            ['activity', '活动', History],
          ] as const).map(([id, label, Icon]) => (
            <Button
              key={id}
              variant="ghost"
              className={cn('lume-segmented-item min-h-10', section === id && 'lume-segmented-item-active')}
              onClick={() => setDeepLink({ section: id, workspaceSlug })}
              data-memory-center-section={id}
            >
              <Icon size={14} />
              {label}
            </Button>
          ))}
        </div>
      </header>

      <main className="agent-message-scrollbar w-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pb-6 pt-4 md:px-8 lg:px-10 lg:pb-8">
        {section === 'attention' && (
          <MemoryAttentionView
            suggestions={suggestions}
            pendingItems={pendingItems}
            pendingCount={pendingCount}
            memoryCount={memoryCount}
            stats={stats}
            busySuggestionId={busyId}
            busyPendingId={busyPendingId}
            onActSuggestion={(id, feedback) => void handleAct(id, feedback)}
            onDeleteSuggestion={(id) => void handleDelete(id)}
            onResolvePending={(item, action) => void handlePending(item, action)}
          />
        )}
        {section === 'memory' && <MemoryLibraryView />}
        {section === 'insights' && workspaceSlug && (
          <MemoryInsightsView
            workspaceSlug={workspaceSlug}
            snapshot={snapshot}
            suggestions={suggestions}
            busySuggestionId={busyId}
            onActSuggestion={(id, feedback) => void handleAct(id, feedback)}
            onDeleteSuggestion={(id) => void handleDelete(id)}
          />
        )}
        {section === 'activity' && <MemoryActivityView />}
      </main>
    </div>
  )
}
