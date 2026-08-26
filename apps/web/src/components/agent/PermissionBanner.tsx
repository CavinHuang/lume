import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { Bot, Check, ChevronRight, ShieldOff, TerminalSquare, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PierreDiffView, createPierreFileDiff } from '@/components/diff/PierreDiffView'
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
  /** 收起态上浮(动线 F3):父级据此放行被遮蔽的输入框 */
  onHiddenChange?: (hidden: boolean) => void
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

export function PermissionBanner({ threadId, request, onHiddenChange }: PermissionBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const setThreadPermissionModes = useSetAtom(agentThreadPermissionModesAtom)
  const [choice, setChoice] = useState<AgentToolPermissionDecision>('allow_once')
  const [allowScope, setAllowScope] = useState<AgentToolPermissionAllowScope>('exact')
  const [allowAllInThread, setAllowAllInThread] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const classification = request.classification
  const canAllowAlways = request.canAllowAlways !== false
  // command 档仅对带命令/文本输入的工具有意义（#558）
  const hasCommandInput = ['command', 'cmd', 'prompt', 'query'].some(
    (key) => typeof request.input?.[key] === 'string' && (request.input[key] as string).trim(),
  )
  const allowScopeHint: Record<AgentToolPermissionAllowScope, string> = {
    exact: '仅此调用',
    command: hasCommandInput ? '相同命令（参数可变）' : '相同目标',
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
    onHiddenChange?.(hidden)
  }, [hidden, onHiddenChange])

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
      // 三轮 review(UI F6):sidecar 回传实际生效档——宽档被否决静默降级 exact 时
      // toast 不再谎报;旧 sidecar 无字段时回落本地选择
      const result = await sidecarCall<{ ok: true; effectiveScope?: AgentToolPermissionAllowScope }>(
        AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION,
        payload,
      )
      if (payload.threadPermissionMode === 'bypassPermissions') {
        setThreadPermissionModes((prev) => ({ ...prev, [threadId]: 'bypassPermissions' }))
      }
      // 作用域回执（#558）：明确告知「始终允许」的真实生效范围，本线程内有效。
      // review F5:按档位单独成句,避免「…调用的 Bash 调用」重复拼接
      if (choice === 'allow_always') {
        const effectiveScope = result?.effectiveScope ?? allowScope
        const scopeCopy: Record<AgentToolPermissionAllowScope, string> = {
          exact: hasCommandInput || request.preview
            ? `已允许本线程内的此调用（${request.toolName} 的组合形态仍会再次询问）`
            : '已允许本线程内逐字节相同的此调用',
          command: `已允许本线程内相同的 ${request.toolName} 命令（参数可变）`,
          tool: `已允许本线程内所有 ${request.toolName} 调用${request.risk === 'high' ? '（含危险操作）' : ''}`,
        }
        toast.success(scopeCopy[effectiveScope])
      }
      setPending((prev) => removePendingToolPermissionEverywhere(prev, request.requestId, threadId))
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
          {request.preview?.kind === 'diff' && (
            <PermissionDiffPreview preview={request.preview} />
          )}
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
          <div
            role="radiogroup"
            aria-label="始终允许的范围"
            className="ml-2 space-y-1"
            onKeyDown={(event) => {
              // 动线 F10:radio 惯例——上下方向键在档位间移动
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              const group = event.currentTarget
              const options = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
              const index = options.indexOf(document.activeElement as HTMLButtonElement)
              const next = options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length]
              next?.focus()
              next?.click()
            }}
          >
            {([
              { value: 'exact', label: '仅此调用', hint: '逐字节相同才免审批', danger: false },
              ...(hasCommandInput ? [{ value: 'command', label: '相同命令', hint: '同一命令、参数可变', danger: false }] : []),
              {
                value: 'tool',
                label: `整个 ${request.toolName} 工具`,
                // 安全 F3:高危工具的工具级授权明确代价,不再无差别一句提示
                hint: request.risk === 'high'
                  ? '危险：包括删除、推送等所有调用'
                  : '该工具全部调用都放行',
                danger: request.risk === 'high',
              },
            ] as Array<{ value: AgentToolPermissionAllowScope; label: string; hint: string; danger?: boolean }>).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={allowScope === option.value}
                onClick={() => setAllowScope(option.value)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded-[8px] border px-2 py-1 text-left text-[12px] transition-colors',
                  allowScope === option.value
                    ? option.danger
                      ? 'border-[#6e3c3c] bg-[#3b2a2a] text-[#ffc0c0]'
                      : 'border-white/[0.14] bg-white/[0.08] text-[#f0f0f0]'
                    : 'border-transparent text-[#9b9b9b] hover:bg-white/[0.04]',
                )}
              >
                <Check size={12} className={cn('shrink-0', allowScope === option.value ? 'opacity-100' : 'opacity-0')} />
                <span className="font-semibold">{option.label}</span>
                <span className={cn(option.danger ? (allowScope === option.value ? 'text-[#ffb4b4]' : 'text-[#c98a8a]') : 'text-[#898989]')}>{option.hint}</span>
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

function PermissionDiffPreview({ preview }: { preview: NonNullable<AgentToolPermissionRequest['preview']> }) {
  const stats = useMemo(() => {
    try {
      const files = createPierreFileDiff({
        oldContent: preview.oldText,
        newContent: preview.newText,
        filePath: preview.path ?? 'preview',
      })
      return files.reduce(
        (acc, file) => ({
          added: acc.added + file.hunks.reduce((count, hunk) => count + hunk.additionLines, 0),
          removed: acc.removed + file.hunks.reduce((count, hunk) => count + hunk.deletionLines, 0),
        }),
        { added: 0, removed: 0 },
      )
    } catch {
      return { added: 0, removed: 0 }
    }
  }, [preview.oldText, preview.newText, preview.path])

  return (
    <div className="mt-2 overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#1b1b1b]">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-1.5 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[#bdbdbd]">{preview.path ?? '变更预览'}</span>
        <span className="tabular-nums text-emerald-400">+{stats.added}</span>
        <span className="tabular-nums text-red-400">-{stats.removed}</span>
      </div>
      <PierreDiffView
        oldContent={preview.oldText}
        newContent={preview.newText}
        filePath={preview.path ?? 'preview'}
        compact
        disableHeader
        className="max-h-56"
      />
    </div>
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
