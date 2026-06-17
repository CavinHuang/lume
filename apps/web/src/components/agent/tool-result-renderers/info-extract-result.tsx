/**
 * InfoExtractResult 工具结果渲染器
 *
 * 将信息提取专家的执行过程渲染为多步骤执行计划视图，
 * 包含专家分配卡片、提取配置确认和执行步骤时间线。
 */

import { Loader2, Clock } from 'lucide-react'
import { useState } from 'react'
import { AnimatedCollapsiblePanel } from '@/components/agent/AnimatedCollapsiblePanel'
import { cn } from '@/lib/utils'
import type { InfoExtractStep, InfoExtractExpert, InfoExtractResultData } from '@lume/shared'

// ── Helpers ────────────────────────────────────────────────────

function parseInfoExtractResult(result: unknown): InfoExtractResultData {
  if (!result) return { steps: [] }
  if (typeof result === 'string') {
    try {
      return JSON.parse(result) as InfoExtractResultData
    } catch {
      return { steps: [] }
    }
  }
  if (Array.isArray(result)) {
    return { steps: result.map((s) => ({
      ...s,
      status: (s as InfoExtractStep).status ?? 'pending',
    })) as InfoExtractStep[] }
  }
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>
    const stepsRaw = obj.steps as InfoExtractStep[] | undefined
    const steps: InfoExtractStep[] = (stepsRaw ?? []).map((s) => ({
      ...s,
      status: s.status ?? 'pending',
    }))
    return {
      expert: obj.expert as InfoExtractExpert | undefined,
      configConfirmed: obj.configConfirmed as boolean | undefined,
      steps,
      sourceDocument: obj.sourceDocument as string | undefined,
      extractionType: obj.extractionType as string | undefined,
    }
  }
  return { steps: [] }
}

// ── Sub Components ─────────────────────────────────────────────

function ExpertCard({ expert }: { expert: InfoExtractExpert }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-[#e5e7eb] bg-white shadow-sm">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-gray-50/80"
      >
        {/* Gradient avatar */}
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: `linear-gradient(135deg, ${expert.avatarColor ?? 'rgb(75, 139, 255)'}, rgb(51, 112, 255))`,
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 7V5a2 2 0 0 1 2-2h2" />
            <path d="M17 3h2a2 2 0 0 1 2 2v2" />
            <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
            <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
            <circle cx="12" cy="12" r="3" />
            <path d="m16 16-1.9-1.9" />
          </svg>
        </div>

        {/* Name & badge */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-[#1d2129]">
              {expert.name}
            </span>
            <span
              className="text-[10px] font-medium"
              style={{
                color: 'rgb(51, 112, 255)',
                background: 'rgb(235, 241, 255)',
                padding: '1px 5px',
                borderRadius: '3px',
              }}
            >
              已就绪
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-[#868a94] leading-snug">
            {expert.description}
          </p>
        </div>
      </button>

      {/* Expanded detail */}
      <AnimatedCollapsiblePanel open={expanded}>
        <div className="border-t border-[#f0f1f3] px-3 py-2">
          <div className="space-y-1">
            <p className="text-[11px] text-[#868a94] leading-relaxed">
              <span className="font-medium text-[#4e5969]">职责：</span>
              {expert.description}
            </p>
            <p className="text-[11px] text-[#868a94] leading-relaxed">
              <span className="font-medium text-[#4e5969]">角色：</span>
              {expert.title}
            </p>
          </div>
        </div>
      </AnimatedCollapsiblePanel>
    </div>
  )
}

function ConfigConfirmed() {
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-lg border-l-[3px] px-3 py-2"
      style={{
        borderColor: 'rgb(51, 112, 255)',
        background: 'rgb(255, 255, 255)',
        borderStyle: 'solid',
        borderWidth: '1px 1px 1px 3px',
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="rgb(51, 112, 255)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </svg>
      <span className="text-[12px] font-medium text-[#1d2129]">
        提取配置已确认
      </span>
      <span className="ml-auto text-[10px] text-[rgb(51,112,255)] cursor-pointer">
        展开 ›
      </span>
    </div>
  )
}

function StepItem({
  step,
  isLast,
}: {
  step: InfoExtractStep
  isLast: boolean
}) {
  const [, setExpanded] = useState(false)

  const statusStyles: Record<string, {
    circleBg: string
    circleBorder: string
    iconColor: string
    titleColor: string
    descColor: string
    connectorColor: string
  }> = {
    completed: {
      circleBg: 'rgb(51, 112, 255)',
      circleBorder: 'rgb(51, 112, 255)',
      iconColor: '#fff',
      titleColor: 'rgb(29, 33, 41)',
      descColor: 'rgb(78, 89, 105)',
      connectorColor: 'rgba(51, 112, 255, 0.25)',
    },
    running: {
      circleBg: 'rgb(235, 241, 255)',
      circleBorder: 'rgb(51, 112, 255)',
      iconColor: 'rgb(51, 112, 255)',
      titleColor: 'rgb(29, 33, 41)',
      descColor: 'rgb(78, 89, 105)',
      connectorColor: 'rgba(51, 112, 255, 0.25)',
    },
    pending: {
      circleBg: 'transparent',
      circleBorder: 'rgb(229, 230, 235)',
      iconColor: 'rgb(156, 163, 175)',
      titleColor: 'rgb(78, 89, 105)',
      descColor: 'rgb(156, 163, 175)',
      connectorColor: 'rgb(242, 243, 245)',
    },
  }

  const s = statusStyles[step.status] ?? statusStyles.pending

  const renderIcon = () => {
    if (step.status === 'completed') {
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke={s.iconColor}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )
    }
    if (step.status === 'running') {
      return (
        <Loader2
          size={9}
          className="animate-spin"
          style={{ color: s.iconColor }}
        />
      )
    }
    return <Clock size={8} style={{ color: s.iconColor }} />
  }

  return (
    <div className="flex gap-2 py-1.5">
      {/* Timeline column */}
      <div className="flex w-[18px] shrink-0 flex-col items-center">
        <div
          className="flex size-[18px] shrink-0 items-center justify-center rounded-full"
          style={{
            background: s.circleBg,
            border: `1.5px solid ${s.circleBorder}`,
          }}
        >
          {renderIcon()}
        </div>
        {!isLast && (
          <div
            className="mt-0.5 h-[calc(100%-18px)] w-px flex-1"
            style={{ background: s.connectorColor }}
          />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left"
        >
          <span
            className="text-[12px] font-medium"
            style={{ color: s.titleColor }}
          >
            {step.title}
          </span>
          <p
            className="mt-0.5 text-[11px] leading-relaxed"
            style={{ color: s.descColor }}
          >
            {step.description}
          </p>
          {step.status === 'running' && (
            <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-[rgb(51,112,255)]">
              <Loader2 size={8} className="animate-spin" />
              执行中...
            </span>
          )}
        </button>
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────

interface InfoExtractResultProps {
  input: Record<string, unknown>
  result: unknown
}

export function InfoExtractResult({ result }: InfoExtractResultProps) {
  const data = parseInfoExtractResult(result)
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="w-full max-w-[460px] overflow-hidden rounded-xl border border-[#e1e4ec] bg-white shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-[#fbfcff]"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(51, 112, 255)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
        </svg>
        <span className="text-[12px] font-semibold text-[#1d2129]">
          执行计划
        </span>
        {data.sourceDocument && (
          <span className="text-[11px] text-[#68718a] truncate">
            · {data.sourceDocument}
          </span>
        )}
      </button>

      {/* Expandable content */}
      <AnimatedCollapsiblePanel open={expanded}>
        <div className="border-t border-[#f0f1f3] px-3 pb-3">
          {/* Expert assignment */}
          {data.expert && <ExpertCard expert={data.expert} />}

          {/* Config confirmed */}
          {data.configConfirmed && <ConfigConfirmed />}

          {/* Execution steps timeline */}
          {data.steps.length > 0 && (
            <div>
              {data.steps.map((step, index) => (
                <StepItem
                  key={step.id}
                  step={step}
                  isLast={index === data.steps.length - 1}
                />
              ))}
            </div>
          )}

          {/* Empty state */}
          {data.steps.length === 0 && (
            <p className="py-3 text-center text-[12px] text-[#868a94]">
              暂无执行步骤
            </p>
          )}
        </div>
      </AnimatedCollapsiblePanel>

      {/* Collapsed preview (always visible) */}
      {!expanded && data.steps.length > 0 && (
        <div className="border-t border-[#f0f1f3] px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] text-[#68718a]">
            <span
              className={cn(
                'size-2 rounded-full',
                data.steps.some((s) => s.status === 'running')
                  ? 'bg-blue-500 animate-pulse'
                  : data.steps.every((s) => s.status === 'completed')
                    ? 'bg-green-500'
                    : 'bg-blue-500/50',
              )}
            />
            <span className="truncate">
              {data.steps.filter((s) => s.status === 'completed').length}
              /{data.steps.length} 步骤已完成
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
