import { useEffect, useState } from 'react'
import type { WikiChangeDraft, WikiDraftStatus } from '@lume/shared'
import { Check, FilePlus2, LoaderCircle, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { applyWikiDraft, cancelWikiDraft, getWikiDraftStatus } from '@/lib/desktop-api/wiki'

interface Props {
  result: unknown
}

type ProposalStatus = 'checking' | 'pending' | 'applying' | 'cancelling' | 'applied' | 'pending_review' | 'cancelled' | 'unavailable'
type SettledProposalStatus = Extract<ProposalStatus, 'applied' | 'pending_review' | 'cancelled' | 'unavailable'>

const settledDraftStatuses = new Map<string, ProposalStatus>()

export function parseWikiChangeDraft(result: unknown): WikiChangeDraft | null {
  let candidate = result
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate) } catch { return null }
  }
  if (isRecord(candidate) && isRecord(candidate.data)) candidate = candidate.data
  if (!isRecord(candidate)) return null
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.revision !== 'number'
    || typeof candidate.nonce !== 'string'
    || typeof candidate.title !== 'string'
    || !Array.isArray(candidate.operations)
    || !Array.isArray(candidate.diffs)
  ) return null
  return candidate as unknown as WikiChangeDraft
}

export function WikiProposalResult({ result }: Props) {
  const draft = parseWikiChangeDraft(result)
  const [status, setStatus] = useState<ProposalStatus>('checking')

  useEffect(() => {
    if (!draft) return
    const cached = settledDraftStatuses.get(draft.id)
    if (cached) {
      setStatus(cached)
      return
    }
    let active = true
    setStatus('checking')
    void getWikiDraftStatus(draft.id).then((current) => {
      if (!active) return
      const next = proposalStatusFromDraftStatus(current)
      if (isSettled(next)) settledDraftStatuses.set(draft.id, next)
      setStatus(next)
    }).catch(() => {
      if (active) setStatus('pending')
    })
    return () => { active = false }
  }, [draft?.id])

  if (!draft) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-3 font-mono text-[12px] text-foreground/70">
        {typeof result === 'string' ? result : 'Wiki 草案结果格式无效'}
      </pre>
    )
  }

  const confirm = async () => {
    setStatus('applying')
    try {
      const applied = await applyWikiDraft({
        draftId: draft.id,
        expectedRevision: draft.revision,
        nonce: draft.nonce,
      })
      const next = 'draft' in applied ? 'pending_review' : 'applied'
      settledDraftStatuses.set(draft.id, next)
      setStatus(next)
      toast.success(next === 'pending_review' ? '变更已进入待审核' : '已沉淀到 Wiki')
    } catch (error) {
      setStatus('pending')
      toast.error(error instanceof Error ? error.message : 'Wiki 草案确认失败')
    }
  }

  const cancel = async () => {
    setStatus('cancelling')
    try {
      await cancelWikiDraft(draft.id)
      settledDraftStatuses.set(draft.id, 'cancelled')
      setStatus('cancelled')
      toast.success('已取消 Wiki 草案')
    } catch (error) {
      setStatus('pending')
      toast.error(error instanceof Error ? error.message : 'Wiki 草案取消失败')
    }
  }

  const settled = isSettled(status)
  const busy = status === 'applying' || status === 'cancelling'
  const operationLabel = draft.operations.length === 1 ? '1 个页面变更' : `${draft.operations.length} 个页面变更`

  if (settled) {
    return <WikiProposalSettledSummary title={draft.title} status={status} />
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 text-sm">
      <div className="flex items-start gap-2">
        <FilePlus2 className="mt-0.5 shrink-0 text-[var(--text-2)]" size={16} />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-[var(--text-1)]">{draft.title}</div>
          <div className="mt-1 text-xs text-[var(--text-3)]">{operationLabel} · 尚未写入正式 Wiki</div>
          {draft.riskReasons.length > 0 && (
            <div className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
              <ShieldAlert className="mt-0.5 shrink-0" size={13} />
              <span>{draft.riskReasons.join('；')}</span>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {status === 'checking' ? (
          <span className="flex items-center gap-1 text-xs text-[var(--text-3)]">
            <LoaderCircle className="animate-spin" size={13} />
            正在确认草案状态
          </span>
        ) : (
          <>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void cancel()}>
              {status === 'cancelling' && <LoaderCircle className="animate-spin" size={13} />}
              取消
            </Button>
            <Button size="xs" disabled={busy} onClick={() => void confirm()}>
              {status === 'applying' && <LoaderCircle className="animate-spin" size={13} />}
              确认写入
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

export function WikiProposalSettledSummary({
  title,
  status,
}: {
  title: string
  status: SettledProposalStatus
}) {
  const Icon = status === 'cancelled' ? X : Check
  return (
    <div
      data-wiki-proposal-collapsed="true"
      className="flex w-full items-center gap-1.5 py-0.5 text-[11.5px] text-foreground/40"
    >
      <Icon className="shrink-0" size={12} />
      <span className="shrink-0 font-medium">{settledStatusLabel(status)}</span>
      <span className="text-foreground/25" aria-hidden="true">·</span>
      <span className="min-w-0 truncate" title={title}>{title}</span>
    </div>
  )
}

export function proposalStatusFromDraftStatus(status: WikiDraftStatus): ProposalStatus {
  if (status.state === 'pending_review') return 'pending_review'
  if (status.state === 'applied') return 'applied'
  if (status.state === 'unavailable') return 'unavailable'
  return 'pending'
}

function isSettled(status: ProposalStatus): status is SettledProposalStatus {
  return status === 'applied' || status === 'pending_review' || status === 'cancelled' || status === 'unavailable'
}

function settledStatusLabel(status: ProposalStatus): string {
  if (status === 'applied') return '已写入 Wiki'
  if (status === 'pending_review') return '已提交审核'
  if (status === 'cancelled') return '已取消'
  return '已处理'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
