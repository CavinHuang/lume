import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { Ban, Check, Sparkles, X } from 'lucide-react'
import { suggestionsVersionAtom } from '@/atoms'
import { cn } from '@/lib/utils'
import { actOnSuggestion, listSuggestions } from '@/lib/desktop-api/suggestion'
import { Button } from '@/components/ui/button'
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

  const handleAct = async (id: number, feedback: SuggestionFeedback) => {
    try {
      await actOnSuggestion(id, feedback)
    } catch (err) {
      console.error('[SuggestionBanner] actOnSuggestion failed', err)
      return
    }
    // Task 12 gap：feedback 不触发 sidecar 的 CHANGED 广播，
    // 因此显式重拉一次，确保 UI 立即移除已处理的建议。
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
  onAct: (id: number, feedback: SuggestionFeedback) => void
}) {
  return (
    <section
      data-suggestion-banner={record.id}
      className="animate-in fade-in slide-in-from-bottom-1 mx-auto flex flex-col gap-2.5 rounded-[14px] border border-white/[0.06] bg-[#292929] px-4 py-3 text-white shadow-[0_12px_36px_rgba(0,0,0,0.18)] duration-150 sm:flex-row sm:items-start"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#eaf2ff]/10 text-[#9ec3ff]">
        <Sparkles size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[#bdbdbd]">
            {KIND_LABEL[record.kind]}
          </span>
          <h4 className="truncate text-[13px] font-semibold leading-5 text-[#f5f5f5]">
            {record.title}
          </h4>
        </div>
        {record.reason && (
          <p className="text-[12px] leading-5 text-[#bdbdbd]">{record.reason}</p>
        )}
        {record.evidence && (
          <p className="mt-0.5 text-[11px] leading-4 text-[#8f8f8f]">依据：{record.evidence}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <ActionButton
          action="accepted"
          recordId={record.id}
          onClick={() => onAct(record.id, 'accepted')}
          className="border-white/[0.12] bg-white/[0.04] text-[#d6d6d6] hover:border-white/[0.18] hover:bg-white/[0.10] hover:text-white"
        >
          <Check size={13} />
          接受
        </ActionButton>
        <ActionButton
          action="ignored"
          recordId={record.id}
          aria-label="忽略此建议"
          onClick={() => onAct(record.id, 'ignored')}
          className="border-white/[0.10] bg-transparent text-[#9a9a9a] hover:border-white/[0.16] hover:bg-white/[0.06] hover:text-white"
        >
          <X size={13} />
          忽略
        </ActionButton>
        <ActionButton
          action="never"
          recordId={record.id}
          aria-label="不再建议这类"
          onClick={() => onAct(record.id, 'never')}
          className="border-white/[0.10] bg-transparent text-[#9a9a9a] hover:border-[#6e3c3c] hover:bg-[#3b2a2a] hover:text-[#ffc0c0]"
        >
          <Ban size={13} />
          不再建议这类
        </ActionButton>
      </div>
    </section>
  )
}

function ActionButton({
  action,
  recordId,
  onClick,
  className,
  children,
  'aria-label': ariaLabel,
}: {
  action: SuggestionFeedback
  recordId: number
  onClick: () => void
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
