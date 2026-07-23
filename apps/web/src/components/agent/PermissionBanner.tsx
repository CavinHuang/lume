import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useSetAtom } from 'jotai'
import { Bot, Check, ChevronRight, ShieldAlert, ShieldOff, TerminalSquare, Wrench } from 'lucide-react'
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
  const canAllowAlways = request.canAllowAlways !== false
  const subagentDisplayLabel = getSubagentDisplayLabel(request)
  const sourceLabel = subagentDisplayLabel || '主 Agent'
  const invocationLabel = getInvocationLabel(request.toolName)
  const invocationText = formatToolInput(request.input)

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

  if (hidden) return null

  return (
    <InteractiveOverlayFrame
      kind="tool-permission"
      eyebrow="Permission"
      icon={<ShieldAlert size={18} />}
      title="Lume 想要执行一项操作"
      busy={busy}
      submitLabel={choice === 'deny' ? '拒绝操作' : '确认执行'}
      onIgnore={() => setHidden(true)}
      onSubmit={() => void respond()}
    >
      <div className="space-y-4">
        <div className="rounded-[15px] border border-[#e7ebf1] bg-[#fbfcfe] p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <InfoCell icon={<Wrench size={14} />} label="请求工具" value={request.toolName} mono />
            <InfoCell icon={<Bot size={14} />} label="请求来源" value={sourceLabel} />
          </div>
          <div className="mt-3 rounded-[11px] border border-[#dfe5ee] bg-[#1f232b] px-3 py-2.5 text-white shadow-[0_5px_16px_rgba(31,35,43,0.12)]">
            <div className="mb-1.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#aeb9c8]">
              <TerminalSquare size={13} />
              {invocationLabel}
            </div>
            <pre title={invocationText} className="max-h-10 overflow-hidden whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-[#f5f7fa]">{invocationText}</pre>
          </div>
          <div className="mt-3 border-t border-[#e8edf3] pt-3">
            <p className="text-[13px] leading-5 text-[#4e5968]">{request.reason}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]',
                request.risk === 'high' ? 'bg-[#fff0f0] text-[#d64a4a]' : request.risk === 'medium' ? 'bg-[#fff8e9] text-[#ad7410]' : 'bg-[#edf5ff] text-[#4c82d0]',
              )}>
                {request.risk} risk
              </span>
              {request.originThreadId && <span className="text-[10px] text-[#9aa3b0]">来自关联会话</span>}
            </div>
          </div>
          {request.pluginSensitive && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-[#8a8f98]">
              <span className="rounded-full bg-[#f0f1f3] px-1.5 py-0.5 font-mono text-[#5c626d]">{request.pluginSensitive.pluginId}</span>
              <span className="font-mono">{request.pluginSensitive.capabilityKey}</span>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] leading-4 text-[#9aa3b0]">
            {request.reasonCode && <span>{request.reasonCode}</span>}
            {classification?.reasonCode && classification.reasonCode !== request.reasonCode && <span>{classification.reasonCode}</span>}
            {request.matchedRuleId && <span>{request.matchedRuleId}</span>}
          </div>
          {classification?.explanation && classification.explanation !== request.reason && (
            <p className="mt-2 border-t border-[#edf0f4] pt-2 text-[11px] leading-4 text-[#8a8f98]">{classification.explanation}</p>
          )}
        </div>

        <div>
          <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8290a4]">你希望如何处理？</p>
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="权限处理方式">
            <PermissionChoice
              label="仅这一次"
              hint="下次仍会询问"
              selected={choice === 'allow_once'}
              onClick={() => setChoice('allow_once')}
            />
            {canAllowAlways && (
              <PermissionChoice
                label="始终允许"
                hint={grantLabel || '此类操作'}
                selected={choice === 'allow_always'}
                onClick={() => setChoice('allow_always')}
              />
            )}
            <PermissionChoice
              label="拒绝"
              hint="阻止这次操作"
              selected={choice === 'deny'}
              onClick={() => {
                setAllowAllInThread(false)
                setChoice('deny')
              }}
              danger
            />
          </div>
        </div>
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
              'flex min-h-10 w-full items-center rounded-[11px] border px-3 text-left text-[12px] transition-colors',
              allowAllInThread
                ? 'border-[#5f9cff]/35 bg-[#eef5ff] text-[#1f232b]'
                : 'border-[#e7ebf1] bg-[#fbfcfe] text-[#6f7b8d] hover:border-[#dce5f2] hover:bg-white',
            )}
          >
            <span className="mr-2.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-[#5f9cff]">
              <ShieldOff size={13} />
            </span>
            <span className="min-w-0 flex-1"><span className="font-semibold">本线程内自动允许</span><span className="ml-1 text-[#9aa3b0]">（跳过后续审批）</span></span>
            {allowAllInThread ? <Check size={15} className="text-[#5f9cff]" /> : <ChevronRight size={15} className="text-[#aab3c0]" />}
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
  label,
  hint,
  selected,
  danger = false,
  onClick,
}: {
  label: string
  hint: string
  selected: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <Button
                variant="ghost"
      type="button"
      data-enter-submits
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'flex min-h-[68px] w-full items-start justify-start rounded-[12px] border px-3 py-2.5 text-left transition-colors',
        selected
          ? danger ? 'border-[#f0b5b5] bg-[#fff5f5] text-[#b83c3c]' : 'border-[#9fc4ff] bg-[#f2f7ff] text-[#1f232b]'
          : 'border-[#e7ebf1] bg-[#fbfcfe] text-[#5f6876] hover:border-[#dce5f2] hover:bg-white',
      )}
    >
      <span className={cn(
        'mr-2.5 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
        selected ? danger ? 'border-[#d64a4a] bg-[#d64a4a] text-white' : 'border-[#5f9cff] bg-[#5f9cff] text-white' : 'border-[#cbd3df] bg-white',
      )}>
        {selected && <Check size={10} strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span className={cn('block text-[13px] font-semibold', danger && selected && 'text-[#b83c3c]')}>{label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-[#96a0ad]">{hint}</span>
      </span>
    </Button>
  )
}

function formatToolInput(input: Record<string, unknown>): string {
  const preferred = ['command', 'cmd', 'path', 'file_path', 'url']
  for (const key of preferred) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  const firstValue = Object.values(input).find((value) => typeof value === 'string' && value.trim())
  if (typeof firstValue === 'string') return firstValue.trim()
  return '查看工具参数'
}

function getInvocationLabel(toolName: string): string {
  const normalized = toolName.trim().toLowerCase()
  return normalized === 'bash' || normalized.includes('shell') || normalized.includes('command')
    ? '运行命令'
    : '调用参数'
}

function InfoCell({
  icon,
  label,
  value,
  mono = false,
}: {
  icon: ReactNode
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-[10px] border border-[#e5eaf1] bg-white px-2.5 py-2">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#eef2f7] text-[#657387]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#929cab]">{label}</p>
        <p className={cn('truncate text-[12px] font-semibold text-[#28313d]', mono && 'font-mono')}>{value}</p>
      </div>
    </div>
  )
}
