import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Bot, Check, ChevronRight, ShieldOff, TerminalSquare, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentPendingInteractiveAtom, agentThreadPermissionModesAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentToolPermissionAllowScope, type AgentToolPermissionDecision, type AgentToolPermissionRequest, type AgentToolPermissionResponseInput } from '@lume/shared'
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
  allowAlwaysScope?: AgentToolPermissionAllowScope
}): AgentToolPermissionResponseInput {
  return {
    threadId: input.threadId,
    requestId: input.requestId,
    decision: input.decision,
    ...(input.decision === 'allow_always' && input.allowAlwaysScope && input.allowAlwaysScope !== 'exact'
      ? { allowAlwaysScope: input.allowAlwaysScope }
      : {}),
    ...(input.allowAllInThread && input.decision !== 'deny' ? { threadPermissionMode: 'bypassPermissions' as const } : {}),
  }
}

export function PermissionBanner({ threadId, request }: PermissionBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const setThreadPermissionModes = useSetAtom(agentThreadPermissionModesAtom)
  const [choice, setChoice] = useState<AgentToolPermissionDecision>('allow_once')
  const [allowScope, setAllowScope] = useState<AgentToolPermissionAllowScope>('exact')
  const [allowAllInThread, setAllowAllInThread] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const classification = request.classification
  const grantLabel = request.grantSuggestion?.label
  const canAllowAlways = request.canAllowAlways !== false
  // command 档仅对带命令/文本输入的工具有意义（#558）
  const hasCommandInput = ['command', 'cmd', 'prompt', 'query'].some(
    (key) => typeof request.input?.[key] === 'string' && (request.input[key] as string).trim(),
  )
  const allowScopeHint: Record<AgentToolPermissionAllowScope, string> = {
    exact: '仅逐字节相同的调用',
    command: hasCommandInput ? '相同命令（参数可变）' : '相同路径的调用',
    tool: `所有 ${request.toolName} 调用`,
  }
  const subagentDisplayLabel = getSubagentDisplayLabel(request)
  const sourceLabel = subagentDisplayLabel || '主 Agent'
  const invocationLabel = getInvocationLabel(request.toolName)
  const invocationText = formatToolInput(request.input)

  useEffect(() => {
    setChoice('allow_once')
    setAllowScope('exact')
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
        allowAlwaysScope: allowScope,
      })
      await sidecarCall(AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION, payload)
      if (payload.threadPermissionMode === 'bypassPermissions') {
        setThreadPermissionModes((prev) => ({ ...prev, [threadId]: 'bypassPermissions' }))
      }
      // 作用域回执（#558）：明确告知「始终允许」的真实生效范围，本线程内有效
      if (choice === 'allow_always') {
        toast.success(`已允许本线程内${allowScopeHint[allowScope]}的 ${request.toolName} 调用`)
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

  if (hidden) {
    // Esc 收起后保留可找回入口，否则请求在 sidecar 继续计时、任务静默等到超时
    return (
      <button
        type="button"
        onClick={() => setHidden(false)}
        className="mx-auto flex items-center gap-1.5 rounded-full border border-white/[0.10] bg-[#2a2a2a]/95 px-3 py-1.5 text-[12px] text-[#bdbdbd] shadow-lg backdrop-blur transition-colors hover:bg-[#333] hover:text-[#e5e5e5]"
      >
        <ShieldOff size={12} className="text-[#8f8f8f]" />
        <span className="font-mono">{request.toolName}</span>
        <span>审批已收起，点击查看</span>
      </button>
    )
  }

  return (
    <InteractiveOverlayFrame
      kind="tool-permission"
      title="Lume 想要执行一项操作"
      compact
      meta={(
        <span>
          <span className="font-mono text-[#c5c5c5]">{request.toolName}</span>
          <span className="mx-1.5 text-[#666]">·</span>
          {sourceLabel}
          <span className="mx-1.5 text-[#666]">·</span>
          {request.risk} risk
        </span>
      )}
      progress={{ current: 1, total: canAllowAlways ? 3 : 2 }}
      busy={busy}
      submitLabel={choice === 'deny' ? '拒绝操作' : '确认执行'}
      onIgnore={() => setHidden(true)}
      onSubmit={() => void respond()}
    >
      <div className="space-y-2.5">
        <div className="rounded-[12px] border border-white/[0.08] bg-[#222] p-2.5">
            <div className="grid gap-1.5 sm:grid-cols-2">
            <InfoCell icon={<Wrench size={14} />} label="请求工具" value={request.toolName} mono />
            <InfoCell icon={<Bot size={14} />} label="请求来源" value={sourceLabel} />
          </div>
          <div className="mt-2 rounded-[10px] border border-white/[0.08] bg-[#1b1b1b] px-2.5 py-2 text-white">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[#8f8f8f]">
              <TerminalSquare size={13} />
              {invocationLabel}
            </div>
            <pre title={invocationText} className="max-h-10 overflow-hidden whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-[#f5f7fa]">{invocationText}</pre>
          </div>
          <div className="mt-2 border-t border-white/[0.08] pt-2">
            <p className="truncate text-[12px] leading-5 text-[#bdbdbd]">{request.reason}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]',
                request.risk === 'high' ? 'bg-[#6f3030] text-[#ffb4b4]' : request.risk === 'medium' ? 'bg-[#60491e] text-[#f5ca82]' : 'bg-[#284a6a] text-[#a8d4ff]',
              )}>
                {request.risk} risk
              </span>
              {request.originThreadId && <span className="text-[10px] text-[#777]">来自关联会话</span>}
            </div>
          </div>
          {request.pluginSensitive && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-[#8f8f8f]">
              <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 font-mono text-[#bcbcbc]">{request.pluginSensitive.pluginId}</span>
              <span className="font-mono">{request.pluginSensitive.capabilityKey}</span>
            </div>
          )}
          <div className="mt-1 hidden flex-wrap items-center gap-1.5 text-[10px] leading-4 text-[#777]">
            {request.reasonCode && <span>{request.reasonCode}</span>}
            {classification?.reasonCode && classification.reasonCode !== request.reasonCode && <span>{classification.reasonCode}</span>}
            {request.matchedRuleId && <span>{request.matchedRuleId}</span>}
          </div>
          {classification?.explanation && classification.explanation !== request.reason && (
            <p className="hidden mt-2 border-t border-white/[0.08] pt-2 text-[11px] leading-4 text-[#888]">{classification.explanation}</p>
          )}
        </div>

        <div role="radiogroup" aria-label="权限处理方式">
          <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#858585]">你希望如何处理？</p>
          <div className="space-y-1.5">
            <PermissionChoice
              index={1}
              label="仅这一次"
              hint="下次仍会询问"
              selected={choice === 'allow_once'}
              onClick={() => setChoice('allow_once')}
            />
            {canAllowAlways && (
              <PermissionChoice
                index={2}
                label="始终允许"
                hint={allowScopeHint[allowScope]}
                selected={choice === 'allow_always'}
                onClick={() => setChoice('allow_always')}
              />
            )}
            <PermissionChoice
              index={canAllowAlways ? 3 : 2}
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
        {canAllowAlways && choice === 'allow_always' && (
          <div role="radiogroup" aria-label="始终允许的范围" className="ml-2 space-y-1">
            {([
              { value: 'exact', label: '仅此调用', hint: '逐字节相同才免审批' },
              ...(hasCommandInput ? [{ value: 'command', label: '相同命令', hint: '同一命令、参数可变' }] : []),
              { value: 'tool', label: `整个 ${request.toolName} 工具`, hint: '该工具全部调用都放行' },
            ] as Array<{ value: AgentToolPermissionAllowScope; label: string; hint: string }>).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={allowScope === option.value}
                onClick={() => setAllowScope(option.value)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-[8px] border px-2 py-1 text-left text-[12px] transition-colors',
                  allowScope === option.value
                    ? 'border-white/[0.14] bg-white/[0.08] text-[#f0f0f0]'
                    : 'border-transparent text-[#9b9b9b] hover:bg-white/[0.04]',
                )}
              >
                <Check size={12} className={cn('shrink-0', allowScope === option.value ? 'opacity-100' : 'opacity-0')} />
                <span className="font-semibold">{option.label}</span>
                <span className="text-[#898989]">{option.hint}</span>
              </button>
            ))}
          </div>
        )}
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
              'flex min-h-9 w-full items-center rounded-full border px-3 text-left text-[12px] transition-colors',
              allowAllInThread
                ? 'border-white/[0.14] bg-white/[0.10] text-[#f0f0f0]'
                : 'border-white/[0.08] bg-transparent text-[#919191] hover:bg-white/[0.06] hover:text-[#d0d0d0]',
            )}
          >
            <span className="mr-2 flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[#aaa]">
              <ShieldOff size={13} />
            </span>
            <span className="min-w-0 flex-1"><span className="font-semibold">本线程内自动执行</span><span className="ml-1 text-[#777]">（硬危险操作仍会拦截）</span></span>
            {allowAllInThread ? <Check size={14} className="text-[#e7e7e7]" /> : <ChevronRight size={14} className="text-[#777]" />}
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
  hint,
  selected,
  danger = false,
  onClick,
}: {
  index: number
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
        'group flex min-h-10 w-full items-center justify-start rounded-full border px-2.5 py-1.5 text-left transition-colors',
        selected
          ? danger ? 'border-[#6e3c3c] bg-[#3b2a2a] text-[#ffc0c0]' : 'border-white/[0.10] bg-[#373737] text-[#f5f5f5]'
          : 'border-transparent text-[#9b9b9b] hover:border-white/[0.06] hover:bg-[#333] hover:text-[#e5e5e5]',
      )}
    >
      <span className={cn(
        'mr-2 flex size-8 shrink-0 items-center justify-center rounded-full border text-[12px] font-medium',
        selected ? danger ? 'border-[#8c4d4d] bg-[#6d3434] text-[#ffdada]' : 'border-white/[0.16] bg-[#4a4a4a] text-white' : 'border-white/[0.10] bg-[#333] text-[#aaa]',
      )}>
        {index}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className={cn('text-[13px] font-semibold', danger && selected && 'text-[#ffc0c0]')}>{label}</span>
        <span className="ml-2 text-[12px] text-[#898989]">{hint}</span>
      </span>
      {selected ? <Check size={15} className="mr-1 shrink-0 text-[#ddd]" /> : <ChevronRight size={15} className="mr-1 shrink-0 text-[#777] opacity-0 transition-opacity group-hover:opacity-100" />}
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
    <div className="flex min-w-0 items-center gap-2 rounded-[9px] border border-white/[0.08] bg-white/[0.04] px-2 py-1.5">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[#9b9b9b]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[9px] font-semibold uppercase tracking-[0.08em] text-[#777]">{label}</p>
        <p className={cn('truncate text-[11px] font-semibold text-[#dedede]', mono && 'font-mono')}>{value}</p>
      </div>
    </div>
  )
}
