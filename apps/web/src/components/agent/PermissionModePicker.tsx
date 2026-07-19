import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Map, Pencil, Shield, ShieldCheck, ShieldOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  PERMISSION_OPTIONS,
  TONE_CLASS,
  type PermissionModeIconKey,
  type PermissionModeValue,
  type PermissionOption,
} from '@/components/settings/agent-settings-state'
import { Button } from '@/components/ui/button'
import {
  composerControlChevronClassName,
  composerControlMenuClassName,
  composerControlTriggerClassName,
} from './composer-control-styles'

interface PermissionModePickerProps {
  value: PermissionModeValue
  onChange: (value: PermissionModeValue) => void
}

const iconMap: Record<PermissionModeIconKey, typeof Shield> = {
  shield: Shield,
  pencil: Pencil,
  'shield-check': ShieldCheck,
  'shield-off': ShieldOff,
  map: Map,
}

export function PermissionModePicker({ value, onChange }: PermissionModePickerProps) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = PERMISSION_OPTIONS.find((option) => option.value === value) ?? PERMISSION_OPTIONS[0]
  const CurrentIcon = iconMap[current.icon]

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const handleSelect = (option: PermissionOption) => {
    onChange(option.value)
    setOpen(false)
  }

  return (
    <div ref={menuRef} className="relative">
      <Button
        variant="ghost"
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        className={composerControlTriggerClassName}
        title={`权限模式: ${current.label}`}
      >
        <CurrentIcon size={14} />
        <span className="lume-composer-control-label">{current.label}</span>
        <ChevronDown size={12} className={composerControlChevronClassName} />
      </Button>

      {open && (
        <div className={cn(composerControlMenuClassName, 'w-[268px] p-1.5')}>
          {PERMISSION_OPTIONS.map((option) => (
            <PermissionModeOption
              key={option.value}
              option={option}
              selected={option.value === value}
              onSelect={() => handleSelect(option)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PermissionModeOption({
  option,
  selected,
  onSelect,
}: {
  option: PermissionOption
  selected: boolean
  onSelect: () => void
}) {
  const Icon = iconMap[option.icon]

  return (
    <Button
      variant="ghost"
      type="button"
      onClick={onSelect}
      className={cn(
        'flex h-auto min-h-[52px] w-full items-center justify-start gap-2.5 rounded-lg border px-2.5 py-2 text-left whitespace-normal transition-colors',
        selected
          ? 'border-[color:color-mix(in_oklab,var(--lume-accent)_34%,var(--lume-border-strong))] bg-[var(--lume-accent-soft)]'
          : 'border-transparent hover:bg-[var(--lume-bg-elevated)]',
      )}
    >
      <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border', TONE_CLASS[option.tone])}>
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-medium text-[var(--text-1)]">{option.label}</span>
          <span className={cn('rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium', TONE_CLASS[option.tone])}>
            {option.emphasis}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-[var(--text-3)]">{option.desc}</span>
      </span>
      {selected && <Check size={14} className="shrink-0 text-[var(--brand)]" />}
    </Button>
  )
}
