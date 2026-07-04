/**
 * ThinkingLevelPicker - 思考等级选择器
 *
 * 两种模式：
 * - Popover 模式（默认）：点击按钮弹出浮层，适用于输入框工具栏
 * - 内嵌模式（inline）：横向按钮组，适用于设置页
 */

import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  THINKING_LEVEL_OPTIONS,
  TONE_CLASS,
  type ThinkingLevelOption,
} from '@/components/settings/agent-settings-state'
import type { LumeConfigThinkingLevel } from '@lume/shared'
import {
  composerControlChevronClassName,
  composerControlMenuClassName,
  composerControlTriggerClassName,
} from './composer-control-styles'

export interface ThinkingLevelPickerProps {
  value: LumeConfigThinkingLevel
  onChange: (value: LumeConfigThinkingLevel) => void
  /** 内嵌模式，不使用 popover 包装 */
  inline?: boolean
}

export function ThinkingLevelPicker({ value, onChange, inline }: ThinkingLevelPickerProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || inline) return
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open, inline])

  const handleSelect = (v: LumeConfigThinkingLevel) => {
    onChange(v)
    setOpen(false)
  }

  if (inline) {
    return (
      <ThinkingLevelButtons value={value} onSelect={handleSelect} />
    )
  }

  const current = THINKING_LEVEL_OPTIONS.find((o) => o.value === value) ?? THINKING_LEVEL_OPTIONS[0]

  return (
    <div ref={menuRef} className="relative">
      <Button
        variant="ghost"
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={composerControlTriggerClassName}
      >
        <Brain size={14} />
        <span>思考: {current.label}</span>
        <ChevronDown size={12} className={composerControlChevronClassName} />
      </Button>

      {open && (
        <div className={cn(composerControlMenuClassName, 'min-w-[240px] p-1.5')}>
          <ThinkingLevelCards value={value} onSelect={handleSelect} />
        </div>
      )}
    </div>
  )
}

function ThinkingLevelCards({
  value,
  onSelect,
}: {
  value: LumeConfigThinkingLevel
  onSelect: (v: LumeConfigThinkingLevel) => void
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(nextValue) => { if (nextValue) onSelect(nextValue as LumeConfigThinkingLevel) }}
      className="space-y-1"
    >
      {THINKING_LEVEL_OPTIONS.map((opt) => (
        <ThinkingLevelCard
          key={opt.value}
          option={opt}
          selected={value === opt.value}
        />
      ))}
    </RadioGroup>
  )
}

function ThinkingLevelButtons({
  value,
  onSelect,
}: {
  value: LumeConfigThinkingLevel
  onSelect: (v: LumeConfigThinkingLevel) => void
}) {
  return (
    <div className="lume-segmented grid w-full grid-cols-5">
      {THINKING_LEVEL_OPTIONS.map((option) => {
        const selected = value === option.value
        return (
          <Button
                variant="ghost"
            key={option.value}
            type="button"
            title={`${option.label} - ${option.desc}`}
            onClick={() => onSelect(option.value)}
            className={cn(
              'lume-segmented-item px-1 text-[12px]',
              selected
                ? 'lume-segmented-item-active'
                : '',
            )}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}

function ThinkingLevelCard({
  option,
  selected,
}: {
  option: ThinkingLevelOption
  selected: boolean
}) {
  return (
    <label
      className={cn(
        'group flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-all border',
        selected
          ? 'border-[color:color-mix(in_oklab,var(--lume-accent)_34%,var(--lume-border-strong))] bg-[var(--lume-accent-soft)]'
          : 'border-transparent hover:bg-[var(--lume-bg-elevated)]',
      )}
    >
      <RadioGroupItem
        value={option.value}
        className="shrink-0"
      />
      <Brain
        size={15}
        className={cn(
          'shrink-0 transition-colors',
          TONE_CLASS[option.tone],
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('text-[12.5px] font-medium', selected && 'text-foreground')}>
            {option.label}
          </span>
          <Badge
            variant="outline"
            className={cn(
              'h-[18px] rounded-full border px-1.5 text-[9.5px] font-medium',
              TONE_CLASS[option.tone],
            )}
          >
            {option.emphasis}
          </Badge>
        </div>
        <div className="mt-0.5 text-[10.5px] text-[var(--text-3)]">{option.desc}</div>
      </div>
    </label>
  )
}
