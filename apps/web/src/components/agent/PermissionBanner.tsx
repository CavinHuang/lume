import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentPendingInteractiveAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentToolPermissionDecision, type AgentToolPermissionRequest } from '@lume/shared'
import { removePendingToolPermissionEverywhere } from '@/hooks/pending-interactive-state'
import { getSubagentDisplayLabel } from './subagent-label'
import { InteractiveOverlayFrame } from './InteractiveOverlayFrame'

interface PermissionBannerProps {
  threadId: string
  request: AgentToolPermissionRequest
}

export function PermissionBanner({ threadId, request }: PermissionBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [choice, setChoice] = useState<AgentToolPermissionDecision>('allow_once')
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setChoice('allow_once')
    setHidden(false)
    setBusy(false)
  }, [threadId, request.requestId])

  useEffect(() => {
    if (hidden || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHidden(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hidden])

  const respond = async () => {
    setBusy(true)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION, {
        threadId,
        requestId: request.requestId,
        decision: choice,
      })
      setPending((prev) => removePendingToolPermissionEverywhere(prev, request.requestId))
    } finally {
      setBusy(false)
    }
  }

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
        </div>

        <PermissionChoice
          index={1}
          label="允许一次"
          selected={choice === 'allow_once'}
          onClick={() => setChoice('allow_once')}
        />
        <PermissionChoice
          index={2}
          label="始终允许"
          selected={choice === 'allow_always'}
          onClick={() => setChoice('allow_always')}
        />
        <PermissionChoice
          index={3}
          label="拒绝"
          selected={choice === 'deny'}
          onClick={() => setChoice('deny')}
          danger
        />
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
    <button
      type="button"
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
    </button>
  )
}
