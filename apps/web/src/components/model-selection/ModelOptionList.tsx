import { Brain, Check, Eye, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatContextWindow, formatPricing } from '@lume/shared'
import { ChannelProviderIcon } from './provider-icon-map'
import type { ModelOptionGroup, ModelSelectionOption } from './model-selection-state'

interface ModelOptionListProps {
  groups: ModelOptionGroup[]
  onSelect: (option: ModelSelectionOption) => void
}

function CapabilityIcon({ capability }: { capability: 'vision' | 'toolUse' | 'reasoning' }) {
  const iconMap = {
    vision: Eye,
    toolUse: Wrench,
    reasoning: Brain,
  }
  const Icon = iconMap[capability]
  return <Icon className="size-[10px] opacity-50" />
}

function ModelMetaRow({ meta }: { meta: import('@lume/shared').ModelMeta }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground/80 scale-[0.75] origin-left">
      {meta.capabilities.vision && <CapabilityIcon capability="vision" />}
      {meta.capabilities.toolUse && <CapabilityIcon capability="toolUse" />}
      {meta.capabilities.reasoning && <CapabilityIcon capability="reasoning" />}
      <span className="text-[9px] font-medium opacity-50">
        {formatContextWindow(meta.contextWindow)}
      </span>
      {meta.pricing && (
        <span className="text-[9px] font-medium opacity-40">
          {formatPricing(meta.pricing)}
        </span>
      )}
    </div>
  )
}

export function ModelOptionList({ groups, onSelect }: ModelOptionListProps) {
  return (
    <div className="py-1">
      {groups.map((group) => (
        <div key={group.id} className="py-0.5">
          {/* Channel group header with provider icon */}
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5 -ml-0.5">
            <ChannelProviderIcon provider={group.provider as any} size={16} className="text-foreground/40 shrink-0" />
            <span>{group.label}</span>
          </div>

          {/* Model items */}
          {group.options.map((option) => (
            <button
              key={`${option.channelId}-${option.modelId}`}
              onClick={() => onSelect(option)}
              className={cn(
                'w-full flex items-start gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer select-none transition-colors',
                option.active
                  ? 'bg-primary/15 dark:bg-primary/25'
                  : 'hover:bg-muted/50'
              )}
            >
              {/* Check indicator */}
              <Check
                className={cn(
                  'size-4 shrink-0 mt-0.5',
                  option.active ? 'opacity-100 text-primary' : 'opacity-0'
                )}
              />

              {/* Model content */}
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="truncate">{option.label}</span>
                {option.meta && (
                  <div className="flex items-center justify-between">
                    <ModelMetaRow meta={option.meta} />
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
