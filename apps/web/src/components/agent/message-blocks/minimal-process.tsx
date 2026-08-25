import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bot, Brain, ChevronRight, Clock, Database, Loader2, Package, Terminal, TriangleAlert, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { formatCompletedDuration, formatDurationLabel, formatRunningDuration } from '@/lib/format-duration'
import { AnimatedCollapsiblePanel, useDeferredUnmount } from '../AnimatedCollapsiblePanel'
import { ToolResultRenderer } from '../tool-result-renderers'
import { SubagentInlinePanel } from '../SubagentInlinePanel'
import type { RuntimeAssistantBlock, RuntimeToolCallView } from '../runtime-message-view'
import type { OpenThreadFile } from '../AgentFileReference'
import { asRecord, asString, displayToolName, formatToolErrorOutput, memoryMutationLabel, summarizeInput } from './tool-summary'
import { isDelegationToolName } from '../subagent-run-projection'

type MinimalProcessGroupProps = {
  blocks: RuntimeAssistantBlock[]
  threadId: string
  isStreamingMessage: boolean
  onOpenThreadFile?: OpenThreadFile
  onUserResizeStart?: () => void
}

/**
 * memo 比较函数：blocks 逐元素引用比较（未变 block 引用在投影层已稳定，
 * 见 runtime-event-message-projection 流式 block 引用稳定测试）。
 * 让"已完成 process 段"在活跃段流式追加或计时重渲染时跳过 re-render，
 * 消除简洁模式下多段同时重渲染导致的列表抖动与高度跳变。
 * - 标量 props（isStreamingMessage/threadId）直接比较；
 * - onUserResizeStart 由父级 useCallback 保证引用稳定，不参与比较。
 */
function areMinimalProcessGroupPropsEqual(
  prev: MinimalProcessGroupProps,
  next: MinimalProcessGroupProps,
): boolean {
  if (prev.isStreamingMessage !== next.isStreamingMessage) return false
  if (prev.threadId !== next.threadId) return false
  const prevBlocks = prev.blocks
  const nextBlocks = next.blocks
  if (prevBlocks === nextBlocks) return true
  if (prevBlocks.length !== nextBlocks.length) return false
  for (let i = 0; i < prevBlocks.length; i += 1) {
    if (prevBlocks[i] !== nextBlocks[i]) return false
  }
  return true
}

/**
 * 运行态总用时数字：自维护 setInterval(1000)，每秒只重渲染本 span，
 * 不连带重渲染整个 MinimalProcessGroup（design 7.3：运行态 ⏱ 每秒跳动是有意行为，保留）。
 * - baseMs：过程组内已完成 toolCall 的累计用时（非 Agent + Agent）；
 * - startedAt：当前 running tool 起始时间；缺失时 elapsedMs=0（退化为只显示 baseMs，保留原行为）。
 * tabular-nums 防宽度抖动；text 为空（total≤0 的瞬态）return null。
 */
const RunningDurationClock = memo(function RunningDurationClock({
  baseMs,
  startedAt,
}: {
  baseMs: number
  startedAt?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // interval 只挂一次；startedAt/baseMs 变化由 props 流入，render body 用最新值重算。
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const elapsedMs = startedAt ? Math.max(0, now - Date.parse(startedAt)) : 0
  const text = formatRunningDuration(baseMs + elapsedMs)
  if (!text) return null
  return (
    <span data-running-clock className="inline-flex items-center gap-1 tabular-nums">
      <Clock size={12} />
      {text}
    </span>
  )
})

export const MinimalProcessGroup = memo(function MinimalProcessGroup({
  blocks,
  threadId,
  isStreamingMessage,
  onOpenThreadFile,
  onUserResizeStart,
}: MinimalProcessGroupProps) {
  const [expanded, setExpanded] = useState(false)
  const shouldRenderExpanded = useDeferredUnmount(expanded)

  // 派生计算 memo：blocks 引用由 stabilizeRuntimeMessages + 项 A contentBlocks memo 稳定化，
  // blocks 不变时跳过重算。项 B 移除 now/计时后派生不再依赖时间，可干净 memo。
  const derived = useMemo(() => {
    const toolCalls = blocks
      .filter((b): b is Extract<RuntimeAssistantBlock, { type: 'tool_call' }> => b.type === 'tool_call')
      .map((b) => b.toolCall)
    const subagentCount = toolCalls.filter((tc) => isDelegationToolName(tc.toolName)).length
    const nonAgentCount = toolCalls.length - subagentCount
    const failedCount = toolCalls.filter((tc) => tc.status === 'failed').length
    const completedCount = toolCalls.filter((tc) => tc.status === 'completed').length
    // 仅展示第一个运行中的工具：agent 绝大多数情况顺序执行工具；并发多工具时其余的进度不单独展示。
    const runningTool = toolCalls.find((tc) => tc.status === 'running') ?? null
    const todoBlock = blocks.find((b): b is Extract<RuntimeAssistantBlock, { type: 'todo_update' }> => b.type === 'todo_update')
    const nonAgentDurationMs = toolCalls
      .filter((tc) => !isDelegationToolName(tc.toolName))
      .reduce((sum, tc) => sum + (typeof tc.durationMs === 'number' ? tc.durationMs : 0), 0)
    const subagentDurationMs = toolCalls
      .filter((tc) => isDelegationToolName(tc.toolName))
      .reduce((sum, tc) => sum + (typeof tc.durationMs === 'number' ? tc.durationMs : 0), 0)
    const thinkingCount = blocks.filter((b) => b.type === 'thinking').length
    return {
      toolCalls,
      subagentCount,
      nonAgentCount,
      failedCount,
      completedCount,
      runningTool,
      todoActiveForm: todoBlock?.data.currentActiveForm ?? null,
      nonAgentDurationMs,
      subagentDurationMs,
      thinkingCount,
    }
  }, [blocks])

  const hasRunning = isStreamingMessage && Boolean(derived.runningTool)

  // 折叠行摘要：图标 + 文本单元，用 · 分隔（不再使用 emoji）
  const summaryUnits: ReactNode[] = []
  if (hasRunning && derived.runningTool) {
    // 运行中：当前动作 + 已完成步数 + 总已用时
    summaryUnits.push(
      <span key="run" className="inline-flex items-center gap-1">
        <span className="size-1.5 animate-pulse rounded-full bg-[var(--lume-accent)]" />
        {derived.todoActiveForm ?? `正在执行 ${displayToolName(derived.runningTool.toolName)}`}
      </span>,
    )
    summaryUnits.push(
      <span key="done">
        已完成 {derived.completedCount} 步{derived.failedCount > 0 ? ` · ${derived.failedCount} 失败` : ''}
      </span>,
    )
    // 运行态总用时跳动隔离到 RunningDurationClock：每秒只重渲染该数字，不连带重渲染整个 group。
    // 等价原 if(elapsed) 守卫——有已完成 tool 耗时或 running tool 起始时间才显示（不依赖 now）。
    const runningBaseMs = derived.nonAgentDurationMs + derived.subagentDurationMs
    if (runningBaseMs > 0 || derived.runningTool.startedAt) {
      summaryUnits.push(
        <RunningDurationClock key="dur" baseMs={runningBaseMs} startedAt={derived.runningTool.startedAt} />,
      )
    }
  } else {
    // 完成态：按分类（思考次数 / 工具调用数+时长 / 子代理数+时长 / 失败），按需省略。
    // 完成态时长定格：!hasRunning 下原 toolDurationMs/subagentTotalMs 分别退化为
    // nonAgentDurationMs/subagentDurationMs（runningElapsedMs 恒 0），直接用。
    if (derived.thinkingCount > 0) {
      summaryUnits.push(
        <span key="think" className="inline-flex items-center gap-1">
          <Brain size={12} />
          思考 {derived.thinkingCount} 次
        </span>,
      )
    }
    if (derived.nonAgentCount > 0) {
      const d = formatCompletedDuration(derived.nonAgentDurationMs)
      summaryUnits.push(
        <span key="ops" className="inline-flex items-center gap-1 tabular-nums">
          <Wrench size={12} />
          {derived.nonAgentCount} 个工具调用{d ? ` ${d}` : ''}
        </span>,
      )
    }
    if (derived.subagentCount > 0) {
      const d = formatCompletedDuration(derived.subagentDurationMs)
      summaryUnits.push(
        <span key="sub" className="inline-flex items-center gap-1 tabular-nums">
          <Bot size={12} />
          {derived.subagentCount} 子代理{d ? ` ${d}` : ''}
        </span>,
      )
    }
    if (derived.failedCount > 0) {
      summaryUnits.push(
        <span key="fail" className="inline-flex items-center gap-1 text-destructive/70">
          <TriangleAlert size={12} />
          {derived.failedCount} 失败
        </span>,
      )
    }
  }

  const summaryNodes: ReactNode[] = []
  summaryUnits.forEach((unit, index) => {
    if (index > 0) {
      summaryNodes.push(<span key={`sep-${index}`} className="text-foreground/25">·</span>)
    }
    summaryNodes.push(unit)
  })

  return (
    <div>
      <Button
        variant="ghost"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-auto items-center gap-1.5 p-0 font-normal text-[11.5px] text-foreground/40 transition-colors hover:bg-transparent hover:text-foreground/60"
      >
        {summaryNodes}
        <ChevronRight size={12} className={cn('shrink-0 transition-transform duration-300', expanded && 'rotate-90')} />
      </Button>
      {shouldRenderExpanded && (
        <AnimatedCollapsiblePanel open={expanded}>
          <div className="mt-1.5 space-y-0.5 pl-1">
            {blocks.map((block) => {
              if (block.type === 'thinking') {
                return (
                  <div key={block.id} className="animate-in fade-in slide-in-from-top-1 fill-mode-both duration-300 motion-reduce:animate-none">
                    <MinimalThinkingRow text={block.text} />
                  </div>
                )
              }
              if (block.type === 'tool_call') {
                if (isDelegationToolName(block.toolCall.toolName)) {
                  return (
                    <div key={block.id} className="animate-in fade-in slide-in-from-top-1 fill-mode-both duration-300 motion-reduce:animate-none">
                      <MinimalSubagentRow
                        toolCall={block.toolCall}
                        threadId={threadId}
                        onUserResizeStart={onUserResizeStart}
                      />
                    </div>
                  )
                }
                return (
                  <div key={block.id} className="animate-in fade-in slide-in-from-top-1 fill-mode-both duration-300 motion-reduce:animate-none">
                    <MinimalToolCallRow toolCall={block.toolCall} onOpenThreadFile={onOpenThreadFile} />
                  </div>
                )
              }
              return null
            })}
          </div>
        </AnimatedCollapsiblePanel>
      )}
    </div>
  )
}, areMinimalProcessGroupPropsEqual)

const MinimalToolCallRow = memo(function MinimalToolCallRow({
  toolCall,
  onOpenThreadFile,
}: {
  toolCall: RuntimeToolCallView
  onOpenThreadFile?: OpenThreadFile
}) {
  const [open, setOpen] = useState(false)
  const input = asRecord(toolCall.input)
  const isRunning = toolCall.status === 'running'
  const resultOpen = !isRunning && open
  const shouldRenderResult = useDeferredUnmount(resultOpen)

  let resultData: unknown = toolCall.output
  if (typeof toolCall.output === 'string') {
    try {
      resultData = JSON.parse(toolCall.output)
    } catch {
      resultData = toolCall.output
    }
  }

  const Icon = toolCall.toolName === 'Bash' ? Terminal : Wrench
  const memoryLabel = memoryMutationLabel(toolCall)

  if (memoryLabel) {
    return (
      <div className={cn(
        'flex min-h-5 items-center gap-1.5 py-0.5 text-[11.5px] text-foreground/40',
        toolCall.status === 'failed' && 'text-destructive/70',
      )}>
        {isRunning
          ? <Loader2 size={12} className="shrink-0 animate-spin" />
          : <Database size={12} className="shrink-0" />}
        <span>{memoryLabel}</span>
      </div>
    )
  }

  return (
    <div>
      <Button
                variant="ghost"
        type="button"
        disabled={isRunning}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60 disabled:hover:text-foreground/40"
      >
        <Icon size={12} className="shrink-0" />
        <span className="shrink-0 font-medium">{memoryLabel ?? displayToolName(toolCall.toolName)}</span>
        {toolCall.riskLevel && <span className={cn('shrink-0', riskLevelClassName(toolCall.riskLevel))}>{riskLevelLabel(toolCall.riskLevel)}</span>}
        <span className="min-w-0 flex-1 truncate">{summarizeInput(input, toolCall.toolName)}</span>
        {toolCall.status === 'failed' && <TriangleAlert size={11} className="shrink-0 text-destructive/70" />}
        {typeof toolCall.durationMs === 'number' && toolCall.durationMs > 0 && (
          <span className="shrink-0 tabular-nums">{formatDurationLabel(toolCall.durationMs)}</span>
        )}
        {isRunning ? (
          <Loader2 size={11} className="shrink-0 animate-spin" />
        ) : (
          <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
        )}
      </Button>
      {shouldRenderResult && (
        <AnimatedCollapsiblePanel open={resultOpen}>
          <div className="mb-1 mt-1 max-h-[min(40vh,360px)] overflow-y-auto rounded-md bg-foreground/[0.03] p-2">
            <ToolExecutionDetails toolCall={toolCall} onOpenThreadFile={onOpenThreadFile} />
            <ToolResultRenderer toolName={toolCall.toolName} input={input} result={resultData} />
          </div>
        </AnimatedCollapsiblePanel>
      )}
    </div>
  )
})

const MinimalThinkingRow = memo(function MinimalThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <Button
                variant="ghost"
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60"
      >
        <Brain size={12} className="shrink-0" />
        <span className="flex-1">思考过程</span>
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </Button>
      <AnimatedCollapsiblePanel open={open}>
        <p className="mb-1 mt-1 whitespace-pre-wrap rounded-md bg-foreground/[0.03] p-2 text-[11.5px] leading-relaxed text-foreground/50">
          {text}
        </p>
      </AnimatedCollapsiblePanel>
    </div>
  )
})

const MinimalSubagentRow = memo(function MinimalSubagentRow({
  toolCall,
  threadId,
  onUserResizeStart,
}: {
  toolCall: RuntimeToolCallView
  threadId: string
  onUserResizeStart?: () => void
}) {
  const [open, setOpen] = useState(false)
  const input = asRecord(toolCall.input)
  const label = asString(input.description ?? input.prompt) ?? '子代理'
  return (
    <div>
      <Button
                variant="ghost"
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60"
      >
        <Bot size={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {typeof toolCall.durationMs === 'number' && toolCall.durationMs > 0 && (
          <span className="shrink-0 tabular-nums">{formatDurationLabel(toolCall.durationMs)}</span>
        )}
        <ChevronRight size={12} className={cn('shrink-0 transition-transform', open && 'rotate-90')} />
      </Button>
      <AnimatedCollapsiblePanel open={open}>
        <div className="mb-1 mt-1">
          <SubagentInlinePanel
            threadId={threadId}
            toolUseId={toolCall.id}
            runId={toolCall.subagentRunId}
            status={toolCall.subagentStatus}
            description={asString(input.description ?? input.prompt)}
            agentType={asString(input.subagent_type)}
            prompt={asString(input.prompt)}
            onUserResizeStart={onUserResizeStart}
          />
        </div>
      </AnimatedCollapsiblePanel>
    </div>
  )
})

export function riskLevelLabel(level: NonNullable<RuntimeToolCallView['riskLevel']>): string {
  return level === 'high' ? '高风险' : level === 'medium' ? '中风险' : '低风险'
}

export function riskLevelClassName(level: NonNullable<RuntimeToolCallView['riskLevel']>): string {
  return level === 'high'
    ? 'text-destructive'
    : level === 'medium'
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-emerald-700 dark:text-emerald-300'
}


export function ToolExecutionDetails({
  toolCall,
  onOpenThreadFile,
}: {
  toolCall: RuntimeToolCallView
  onOpenThreadFile?: OpenThreadFile
}) {
  const execution = toolCall.execution
  const resultRef = toolCall.resultRef ?? execution?.resultRef
  const authorizedResultRef = resultRef?.fileRef
  const errorText = toolCall.status === 'failed' ? formatToolErrorOutput(toolCall.output) : ''
  if (!execution && !resultRef && !errorText) return null

  const terminationLabel = execution?.terminationReason === 'completed'
    ? '正常结束'
    : execution?.terminationReason === 'nonzero'
      ? '非零退出'
      : execution?.terminationReason === 'timeout'
        ? '超时'
      : execution?.terminationReason === 'aborted'
          ? '已中止'
          : execution?.terminationReason === 'output_limit'
            ? '输出超限'
          : execution?.terminationReason === 'spawn_error'
            ? '启动失败'
            : null

  return (
    <div className="mb-2 space-y-1 rounded-md bg-foreground/[0.03] px-2.5 py-2 text-[11px] text-foreground/55">
      {errorText && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/20 bg-destructive/[0.06] p-2 font-mono text-[11px] leading-5 text-destructive">{errorText}</pre>}
      {execution?.command && <div className="break-all"><span className="mr-1 text-foreground/40">命令</span><code>{execution.command}</code></div>}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {terminationLabel && <span>结果：{terminationLabel}</span>}
        {typeof execution?.exitCode === 'number' && <span>退出码：{execution.exitCode}</span>}
        {execution?.shell && <span>Shell：{execution.shell === 'powershell' ? 'PowerShell' : 'Bash'}</span>}
        {typeof execution?.durationMs === 'number' && <span>耗时：{formatDurationLabel(execution.durationMs)}</span>}
      </div>
      {execution?.stderrPreview && <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words text-[10px] text-amber-600 dark:text-amber-300">stderr: {execution.stderrPreview}</pre>}
      {resultRef && (
        <div className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-foreground/40">结果文件</span>
          {authorizedResultRef && onOpenThreadFile ? (
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 justify-start gap-1 p-0 text-[11px] font-normal text-[var(--lume-accent)] hover:bg-transparent"
              onClick={() => void onOpenThreadFile(authorizedResultRef.relativePath, authorizedResultRef)}
            >
              <Package size={11} className="shrink-0" />
              <span className="truncate">{authorizedResultRef.relativePath.replace(/^artifacts\//, '')}</span>
            </Button>
          ) : (
            <span className="min-w-0 break-all">{resultRef.path}</span>
          )}
        </div>
      )}
    </div>
  )
}

