import { actOnSuggestion, listSuggestions } from '@/lib/desktop-api/suggestion'
import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { Ban, Check, Loader2, X } from 'lucide-react'
import { suggestionsVersionAtom } from '@/atoms'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RecommendationCard, type RecommendationOption } from './RecommendationCard'
import type { SuggestionFeedback, SuggestionKind, SuggestionRecord } from '@lume/shared'

/**
 * 建议在 banner 中展示的渲染层 TTL：自 createdAt 起 24h 外不展示。
 * 与 sidecar 是否仍保留无关 —— 防止陈旧建议长期挂在输入框上方。
 */
export const SUGGESTION_EXPIRY_MS = 24 * 60 * 60 * 1000

const KIND_LABEL: Record<SuggestionKind, string> = {
  correction: '修正',
  followup: '跟进',
  automation: '自动化',
  todo: '待办',
  skill: '技能',
}

export interface SuggestionBannerProps {
  threadId: string
  workspaceSlug?: string
}

/**
 * 三态建议横幅。挂在 AgentInput 上方（Task 15 接入）：
 * 订阅 suggestionsVersionAtom → sidecar 推送 CHANGED 时 bump → 触发本组件重拉
 * suggestion:list("suggested")；过滤到当前 thread + workspace 且未过期（24h）的记录。
 *
 * 每条建议渲染为一张卡片：kind 标签 + 标题 + 原因 + 依据 + 三个反馈按钮
 * （接受 / 忽略 / 不再建议这类）。点击后调 actOnSuggestion 并显式重拉 ——
 * feedback 不会触发 sidecar 的 CHANGED 广播（Task 12 gap），重拉确保 UI 立即更新。
 */
export function SuggestionBanner({ threadId, workspaceSlug }: SuggestionBannerProps) {
  const version = useAtomValue(suggestionsVersionAtom)
  const [records, setRecords] = useState<SuggestionRecord[]>([])

  useEffect(() => {
    let cancelled = false
    listSuggestions('suggested')
      .then((all) => {
        if (cancelled) return
        setRecords(filterVisible(all, threadId, workspaceSlug))
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('[SuggestionBanner] listSuggestions failed', err)
        }
      })
    return () => {
      cancelled = true
    }
  }, [threadId, workspaceSlug, version])

  const handleAct = async (id: number, feedback: SuggestionFeedback): Promise<void> => {
    try {
      await actOnSuggestion(id, feedback)
    } catch (err) {
      console.error('[SuggestionBanner] actOnSuggestion failed', err)
      throw err
    }
    setRecords((current) => current.filter((record) => record.id !== id))
    // Task 12 gap：feedback 不触发 sidecar 的 CHANGED 广播，
    // 因此先乐观移除，再显式重拉一次与持久层收敛。
    try {
      const all = await listSuggestions('suggested')
      setRecords(filterVisible(all, threadId, workspaceSlug))
    } catch (err) {
      console.error('[SuggestionBanner] reload after act failed', err)
    }
  }

  if (records.length === 0) return null

  return (
    <div className="px-3 pb-2 sm:px-6">
      <div className="mx-auto max-w-[920px] space-y-2">
        {records.map((record) => (
          <SuggestionCard key={record.id} record={record} onAct={handleAct} />
        ))}
      </div>
    </div>
  )
}

function filterVisible(
  all: SuggestionRecord[],
  threadId: string,
  workspaceSlug: string | undefined,
): SuggestionRecord[] {
  const now = Date.now()
  return all.filter(
    (r) =>
      r.threadId === threadId &&
      r.workspaceSlug === workspaceSlug &&
      now - r.createdAt < SUGGESTION_EXPIRY_MS,
  )
}

function SuggestionCard({
  record,
  onAct,
}: {
  record: SuggestionRecord
  onAct: (id: number, feedback: SuggestionFeedback) => Promise<void>
}) {
  const [busyAction, setBusyAction] = useState<SuggestionFeedback | null>(null)
  const [error, setError] = useState<string | null>(null)
  const option: RecommendationOption = {
    key: String(record.id),
    body: record.reason || record.title,
    short: record.title,
    signal: confidenceSignal(record.rawConfidence),
  }

  const act = async (feedback: SuggestionFeedback) => {
    if (busyAction) return
    setBusyAction(feedback)
    setError(null)
    try {
      await onAct(record.id, feedback)
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试')
      setBusyAction(null)
    }
  }

  return (
    <section data-suggestion-banner={record.id} className="mx-auto">
      <RecommendationCard
        className="max-w-none shadow-[0_12px_36px_var(--lume-shadow-panel)]"
        eyebrow={KIND_LABEL[record.kind]}
        title={record.title}
        options={[option]}
        evidence={record.evidence}
        disabled={busyAction !== null}
        error={error}
        footerActions={(
          <>
            <ActionButton
              action="accepted"
              recordId={record.id}
              busy={busyAction === 'accepted'}
              disabled={busyAction !== null}
              onClick={() => void act('accepted')}
              className="border-[color:color-mix(in_oklab,var(--lume-accent)_24%,var(--lume-border-subtle))] bg-[var(--lume-accent-soft)] text-[var(--lume-accent)] hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_14%,var(--lume-bg-elevated))]"
            >
              {busyAction === 'accepted' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              接受
            </ActionButton>
            <ActionButton
              action="ignored"
              recordId={record.id}
              aria-label="忽略此建议"
              busy={busyAction === 'ignored'}
              disabled={busyAction !== null}
              onClick={() => void act('ignored')}
              className="border-[var(--lume-border-subtle)] text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
            >
              {busyAction === 'ignored' ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
              忽略
            </ActionButton>
            <ActionButton
              action="never"
              recordId={record.id}
              aria-label="不再建议这类"
              busy={busyAction === 'never'}
              disabled={busyAction !== null}
              onClick={() => void act('never')}
              className="border-[var(--lume-border-subtle)] text-[var(--lume-text-muted)] hover:border-destructive/25 hover:bg-destructive/8 hover:text-destructive"
            >
              {busyAction === 'never' ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />}
              不再建议这类
            </ActionButton>
          </>
        )}
      />
    </section>
  )
}

export function confidenceSignal(confidence: number): RecommendationOption['signal'] {
  if (confidence >= 0.75) return 3
  if (confidence >= 0.5) return 2
  if (confidence > 0) return 1
  return 0
}

function ActionButton({
  action,
  recordId,
  onClick,
  busy,
  disabled,
  className,
  children,
  'aria-label': ariaLabel,
}: {
  action: SuggestionFeedback
  recordId: number
  onClick: () => void
  busy: boolean
  disabled: boolean
  className: string
  children: React.ReactNode
  'aria-label'?: string
}) {
  return (
    <Button
      variant="ghost"
      type="button"
      data-suggestion-action={action}
      data-suggestion-record-id={recordId}
      aria-label={ariaLabel}
      aria-busy={busy}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] font-semibold',
        className,
      )}
    >
      {children}
    </Button>
  )
}
