import { Brain, Check, Eye, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { formatContextWindow, formatPricing, type ModelCapabilities, type ModelMeta } from '@lume/shared'
import { ChannelProviderIcon } from './provider-icon-map'
import type { ModelOptionGroup, ModelSelectionOption } from './model-selection-state'

interface ModelOptionListProps {
  groups: ModelOptionGroup[]
  onSelect: (option: ModelSelectionOption) => void
  renderBadge?: (option: ModelSelectionOption) => ReactNode
}

function CapabilityIcon({ capability }: { capability: 'vision' | 'toolUse' | 'reasoning' }) {
  const icons = { vision: Eye, toolUse: Wrench, reasoning: Brain }
  const Icon = icons[capability]
  return (
    <span className="inline-flex items-center justify-center">
      <Icon className="h-2.5 w-2.5 opacity-50" />
    </span>
  )
}

function CapabilityRow({ capabilities }: { capabilities: ModelCapabilities }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground/80 scale-[0.75] origin-left">
      {capabilities.vision && <CapabilityIcon capability="vision" />}
      {capabilities.toolUse && <CapabilityIcon capability="toolUse" />}
      {capabilities.reasoning && <CapabilityIcon capability="reasoning" />}
    </div>
  )
}

function ModelMetaRow({ meta }: { meta: ModelMeta }) {
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

export function ModelOptionList({ groups, onSelect, renderBadge }: ModelOptionListProps) {
  return (
    <div className="py-1">
      {groups.map((group) => (
        <div key={group.id}>
          {/* Channel group header with provider icon */}
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 -ml-0.5">
              <ChannelProviderIcon provider={group.provider} size={16} className="text-foreground/40 shrink-0" />
              <span>{group.label}</span>
            </span>
          </div>

          {/* Model items */}
          {group.options.map((option) => {
            const badge = renderBadge?.(option)

            return (
              <button
                key={`${option.channelId}-${option.modelId}`}
                onClick={() => onSelect(option)}
                className={cn(
                  'flex items-start gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer select-none transition-colors w-full text-left',
                  option.active
                    ? 'bg-primary/15 dark:bg-primary/25'
                    : 'hover:bg-muted/50'
                )}
              >
                <Check
                  className={cn(
                    'h-4 w-4 shrink-0 mt-0.5',
                    option.active ? 'opacity-100 text-primary' : 'opacity-0'
                  )}
                />
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {badge}
                  </div>
                  <div className="flex items-center justify-between">
                    {option.meta ? (
                      <ModelMetaRow meta={option.meta} />
                    ) : option.inferredCapabilities ? (
                      <CapabilityRow capabilities={option.inferredCapabilities} />
                    ) : (
                      <span className="text-muted-foreground/50 font-mono text-[10px] scale-[0.75] origin-left">
                        {option.modelId}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
