import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { Check, ShieldOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentPendingInteractiveAtom, agentThreadPermissionModesAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentToolPermissionDecision, type AgentToolPermissionRequest, type AgentToolPermissionResponseInput } from '@lume/shared'
import { removePendingToolPermissionEverywhere } from '@/hooks/pending-interactive-state'
import { getSubagentDisplayLabel } from './subagent-label'
import { InteractiveOverlayFrame, shouldSubmitInteractiveOverlayOnEnter } from './InteractiveOverlayFrame'

import { Button } from '@/components/ui/button'
interface PermissionBannerProps {
  threadId: string
  request: AgentToolPermissionRequest
}

export function buildToolPermissionSubmission(input: {
  threadId: string
  requestId: string
  decision: AgentToolPermissionDecision
  allowAllInThread: boolean
}): AgentToolPermissionResponseInput {
  return {
    threadId: input.threadId,
    requestId: input.requestId,
    decision: input.decision,
    ...(input.allowAllInThread && input.decision !== 'deny' ? { threadPermissionMode: 'bypassPermissions' as const } : {}),
  }
}

export function PermissionBanner({ threadId, request }: PermissionBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const setThreadPermissionModes = useSetAtom(agentThreadPermissionModesAtom)
  const [choice, setChoice] = useState<AgentToolPermissionDecision>('allow_once')
  const [allowAllInThread, setAllowAllInThread] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const classification = request.classification
  const grantLabel = request.grantSuggestion?.label
  const alwaysAllowLabel = grantLabel ? `始终允许 ${grantLabel}` : '始终允许'
  const canAllowAlways = request.canAllowAlways !== false

  useEffect(() => {
    setChoice('allow_once')
    setAllowAllInThread(false)
    setHidden(false)
    setBusy(false)
    setError(null)
  }, [threadId, request.requestId])

  useEffect(() => {
    if (!canAllowAlways && choice === 'allow_always') {
      setChoice('allow_once')
    }
    if (!canAllowAlways && allowAllInThread) {
      setAllowAllInThread(false)
    }
  }, [allowAllInThread, canAllowAlways, choice])

  const respond = async () => {
    setBusy(true)
    setError(null)
    try {
      const payload = buildToolPermissionSubmission({
        threadId,
        requestId: request.requestId,
        decision: choice,
        allowAllInThread,
      })
      await sidecarCall(AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION, payload)
      if (payload.threadPermissionMode === 'bypassPermissions') {
        setThreadPermissionModes((prev) => ({ ...prev, [threadId]: 'bypassPermissions' }))
      }
      setPending((prev) => removePendingToolPermissionEverywhere(prev, request.requestId))
    } catch (err) {
      // Release 构建无 DevTools，把提交失败直接显示在卡片上，便于定位（会话不匹配 / 请求已失效等）。
      console.error('[PermissionBanner] submit failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (hidden || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHidden(true)
        return
      }
      if (shouldSubmitInteractiveOverlayOnEnter(event, event.target) && !busy) {
        void respond()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hidden, busy, respond])

  const subagentDisplayLabel = getSubagentDisplayLabel(request)

  if (hidden) return null

  return (
    <InteractiveOverlayFrame
      kind="tool-permission"
      title="确认工具执行?"
      busy={busy}
      onIgnore={() => setHidden(true)}
      onSubmit={() => void respond()}
    >
      <div className="space-y-1">
        <div className="px-1 pb-1.5">
          <div className="flex items-center gap-2 text-[13px] leading-5 text-[#5c626d]">
            <span className="font-mono font-semibold text-[#1f232b]">{request.toolName}</span>
            <span className={cn(
              'rounded-full px-1.5 py-0.5 text-[11px] font-semibold',
              request.risk === 'high' ? 'bg-red-50 text-red-600' : request.risk === 'medium' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-600',
            )}>
              {request.risk}
            </span>
            {subagentDisplayLabel && <span className="truncate text-[12px] text-[#8a8f98]">{subagentDisplayLabel}</span>}
          </div>
          <p className="mt-0.5 text-[12px] leading-5 text-[#8a8f98]">{request.reason}</p>
          {request.pluginSensitive && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-[#8a8f98]">
              <span className="rounded-full bg-[#f0f1f3] px-1.5 py-0.5 font-mono text-[#5c626d]">{request.pluginSensitive.pluginId}</span>
              <span className="font-mono">{request.pluginSensitive.capabilityKey}</span>
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-[#8a8f98]">
            {request.reasonCode && <span>{request.reasonCode}</span>}
            {classification?.reasonCode && classification.reasonCode !== request.reasonCode && <span>{classification.reasonCode}</span>}
            {request.matchedRuleId && <span>{request.matchedRuleId}</span>}
          </div>
          {classification?.explanation && classification.explanation !== request.reason && (
            <p className="mt-1 text-[11px] leading-4 text-[#8a8f98]">{classification.explanation}</p>
          )}
        </div>

        <PermissionChoice
          index={1}
          label="允许一次"
          selected={choice === 'allow_once'}
          onClick={() => setChoice('allow_once')}
        />
        {canAllowAlways && (
          <PermissionChoice
            index={2}
            label={alwaysAllowLabel}
            selected={choice === 'allow_always'}
            onClick={() => setChoice('allow_always')}
          />
        )}
        <PermissionChoice
          index={canAllowAlways ? 3 : 2}
          label="拒绝"
          selected={choice === 'deny'}
          onClick={() => {
            setAllowAllInThread(false)
            setChoice('deny')
          }}
          danger
        />
        {canAllowAlways && (
          <Button
                variant="ghost"
            type="button"
            onClick={() => {
              const next = !allowAllInThread
              setAllowAllInThread(next)
              if (next) setChoice('allow_once')
            }}
            className={cn(
              'mt-1 flex min-h-9 w-full items-center rounded-[12px] border px-2.5 text-left text-[13px] transition-colors',
              allowAllInThread
                ? 'border-[#5f9cff]/35 bg-[#eef5ff] text-[#1f232b]'
                : 'border-transparent text-[#8a8f98] hover:bg-[#f6f6f7]',
            )}
          >
            <span className="mr-2 flex size-6 shrink-0 items-center justify-center rounded-full bg-white/70 text-[#5f9cff]">
              <ShieldOff size={14} />
            </span>
            <span className="min-w-0 flex-1 font-semibold">本线程全部允许</span>
            {allowAllInThread && <Check size={15} className="text-[#5f9cff]" />}
          </Button>
        )}
        {error && (
          <p className="px-1 pt-1 text-[12px] leading-5 text-red-600">{error}</p>
        )}
      </div>
    </InteractiveOverlayFrame>
  )
}

function PermissionChoice({
  index,
  label,
  selected,
  danger = false,
  onClick,
}: {
  index: number
  label: string
  selected: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <Button
                variant="ghost"
      type="button"
      data-enter-submits
      onClick={onClick}
      className={cn(
        'flex min-h-10 w-full items-center rounded-[12px] px-2.5 text-left text-[14px] transition-colors',
        selected ? 'bg-[#f1f1f3] text-[#1f232b]' : 'text-[#8a8f98] hover:bg-[#f6f6f7]',
      )}
    >
      <span className="w-7 shrink-0 text-[14px] text-[#8a8f98]">{index}.</span>
      <span className={cn('flex min-w-0 flex-1 items-center gap-2 font-semibold', danger && selected && 'text-destructive')}>
        {label}
        {selected && <Check size={15} className={danger ? 'text-destructive' : 'text-[#5f9cff]'} />}
      </span>
    </Button>
  )
}
