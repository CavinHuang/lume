/**
 * RecommendationCard — 主动建议卡
 *
 * 视觉与交互源自 beautifului.dev 的 Recommendation Card（MIT），
 * 改造点：token 对齐 Lume（--text-1/2/3、--border、--surface、--brand）、
 * demo 硬编码数据 props 化、body 由 ReactNode 收敛为 string。
 *
 * 结构：标题问句 + 当前方案描述 + 备选项抽屉（点击晋升为主方案）
 * + 底栏（三格置信信号条 + Alternatives 开关 + Accept→已接受）。
 * 预留接入点：主动建议（对标 Proma#1409）的呈现层。
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export interface RecommendationOption {
  key: string
  /** 主方案完整描述 */
  body: string
  /** 备选抽屉里的一句话摘要 */
  short: string
  /** 0-3 三格置信信号 */
  signal: 0 | 1 | 2 | 3
  /** 置信标签，缺省按 signal 推断 */
  label?: string
  /** 接受按钮文案 */
  cta?: string
}

export interface RecommendationCardProps {
  /** 标题上方的分类标签 */
  eyebrow?: string
  /** 标题问句 */
  title: string
  options: RecommendationOption[]
  /** 初始选中项 key，缺省第一项 */
  defaultSelectedKey?: string
  /** 受控选中项 */
  selectedKey?: string
  /** 支撑当前建议的补充依据 */
  evidence?: string
  /** 点击接受 */
  onAccept?: (option: RecommendationOption) => void | Promise<void>
  /** 切换选中项（含备选晋升） */
  onSelect?: (option: RecommendationOption) => void
  /** 由业务层注入忽略、永久关闭等次级动作 */
  footerActions?: ReactNode
  disabled?: boolean
  accepted?: boolean
  error?: string | null
  className?: string
}

const SIGNAL_TONES: Record<RecommendationOption['signal'], string> = {
  3: 'var(--lume-success)',
  2: 'var(--lume-warning)',
  1: 'var(--text-3)',
  0: 'var(--text-3)',
}

const SIGNAL_LABELS: Record<RecommendationOption['signal'], string> = {
  3: '高置信',
  2: '需确认',
  1: '待定',
  0: '无信号',
}

function optionLabel(option: RecommendationOption): string {
  return option.label ?? SIGNAL_LABELS[option.signal]
}

function optionTone(option: RecommendationOption): string {
  return SIGNAL_TONES[option.signal]
}

function Meter({ signal, tone }: { signal: RecommendationOption['signal']; tone: string }) {
  return (
    <span className="flex items-end gap-0.5" aria-hidden>
      {[0, 1, 2].map((bar) => (
        <span
          key={bar}
          className="w-1 rounded-full transition-colors duration-300"
          style={{ height: 10, background: bar < signal ? tone : 'var(--border-strong)' }}
        />
      ))}
    </span>
  )
}

export function RecommendationCard({
  eyebrow,
  title,
  options,
  defaultSelectedKey,
  selectedKey: controlledSelectedKey,
  evidence,
  onAccept,
  onSelect,
  footerActions,
  disabled = false,
  accepted: controlledAccepted,
  error,
  className,
}: RecommendationCardProps) {
  const alternativesId = useId()
  const [selectedKey, setSelectedKey] = useState(defaultSelectedKey ?? options[0]?.key)
  const [open, setOpen] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const acceptingRef = useRef(false)

  const resolvedSelectedKey = controlledSelectedKey ?? selectedKey
  const selectedIndex = Math.max(0, options.findIndex((option) => option.key === resolvedSelectedKey))
  const active = options[selectedIndex]
  const isAccepted = controlledAccepted ?? accepted
  const isBusy = disabled || accepting

  useEffect(() => {
    if (controlledSelectedKey !== undefined) return
    if (options.some((option) => option.key === selectedKey)) return
    setSelectedKey(options[0]?.key)
    setAccepted(false)
    setAcceptError(null)
    setOpen(false)
  }, [controlledSelectedKey, options, selectedKey])

  if (!active) return null

  const promote = (index: number) => {
    if (isBusy) return
    if (controlledSelectedKey === undefined) setSelectedKey(options[index].key)
    setAccepted(false)
    setAcceptError(null)
    setOpen(false)
    onSelect?.(options[index])
  }

  const accept = async () => {
    if (!onAccept || isBusy || isAccepted || acceptingRef.current) return
    acceptingRef.current = true
    setAccepting(true)
    setAcceptError(null)
    try {
      await onAccept(active)
      if (controlledAccepted === undefined) setAccepted(true)
    } catch (cause) {
      setAcceptError(cause instanceof Error ? cause.message : '操作失败，请重试')
    } finally {
      acceptingRef.current = false
      setAccepting(false)
    }
  }

  return (
    <div
      data-recommendation-card
      className={cn(
        'animate-in fade-in slide-in-from-bottom-1 w-full max-w-95 overflow-hidden rounded-xl border border-[color:var(--border)] bg-[color:var(--surface-2)] duration-300 motion-reduce:animate-none',
        className,
      )}
    >
      <div className="px-3.5 py-3">
        {eyebrow ? (
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--text-3)]">{eyebrow}</span>
        ) : null}
        <span className="text-[13px] font-semibold text-[color:var(--text-1)]">{title}</span>
        <p
          key={active.key}
          className="mt-1.5 min-h-12 animate-in fade-in text-[13px] leading-relaxed text-[color:var(--text-2)] duration-150"
        >
          {active.body}
        </p>
        {evidence ? (
          <p className="mt-1 text-[11px] leading-4 text-[color:var(--text-3)]">依据：{evidence}</p>
        ) : null}
        {error || acceptError ? (
          <p role="alert" className="mt-1.5 text-[11px] leading-4 text-destructive">{error || acceptError}</p>
        ) : null}
      </div>

      {/* 备选项抽屉——独立分区展开 */}
      <div
        id={alternativesId}
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div className="overflow-hidden">
          <div className="border-t border-[color:var(--border)] bg-[color:var(--surface-1)] px-2 py-2">
            <p className="px-1.5 pb-1 text-[11px] font-medium text-[color:var(--text-3)]">其他选项</p>
            {options.map((option, index) => option.key === active.key ? null : (
              <button
                key={option.key}
                type="button"
                disabled={isBusy}
                onClick={() => promote(index)}
                className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-150 hover:bg-[color:color-mix(in_oklab,var(--text-1)_6%,transparent)] disabled:pointer-events-none disabled:opacity-50"
              >
                <Meter signal={option.signal} tone={optionTone(option)} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[color:var(--text-1)]">{option.short}</span>
                <span className="shrink-0 text-[11px] text-[color:var(--text-3)]">{optionLabel(option)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--border)] bg-[color:var(--surface-1)] px-2 py-1.5">
        <span className="flex items-center gap-2">
          <Meter signal={active.signal} tone={optionTone(active)} />
          <span className="text-[12.5px] font-medium text-[color:var(--text-2)]">{optionLabel(active)}</span>
        </span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {footerActions}
          {options.length > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              aria-controls={alternativesId}
              aria-expanded={open}
              disabled={isBusy}
              onClick={() => setOpen((current) => !current)}
              className={cn('transition-[background-color,color,transform] duration-150 active:scale-[0.97]', open && 'bg-[color:color-mix(in_oklab,var(--text-1)_6%,transparent)]')}
            >
              备选
            </Button>
          ) : null}
          {onAccept ? (
            <Button
              size="sm"
              disabled={isBusy || isAccepted}
              aria-busy={accepting}
              onClick={() => void accept()}
              className={cn(
                'transition-[background-color,color,transform] duration-150 active:scale-[0.97]',
                isAccepted
                  ? 'bg-[color:var(--lume-success)] text-[color:var(--lume-bg-elevated)]'
                  : 'bg-[color:var(--brand)] text-[color:var(--brand-foreground)]',
              )}
            >
              {accepting ? '处理中…' : isAccepted ? '已接受' : active.cta ?? '接受'}
            </Button>
          ) : null}
        </span>
      </div>
    </div>
  )
}
