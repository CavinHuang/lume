import { useState, useRef, useEffect, useMemo } from 'react'
import { ChevronDown, Search, Cpu } from 'lucide-react'
import { listChannels } from '@/lib/desktop-api/channel'
import { buildModelSelectionGroups } from '@/components/model-selection/model-selection-state'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import type { ModelSelectionOption, ModelOptionGroup } from '@/components/model-selection/model-selection-state'
import type { Channel } from '@lume/shared'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'

interface WelcomeModelPickerProps {
  onModelChange: (modelRef?: string, channelId?: string, modelId?: string) => void
}

export function WelcomeModelPicker({ onModelChange }: WelcomeModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedLabel, setSelectedLabel] = useState<string>('默认模型')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listChannels().then(setChannels).catch(() => {})
  }, [])

  useEffect(() => {
    getEffectiveLumeConfig()
      .then((config) => {
        if (config.models?.agent?.defaultModelRef) {
          setSelectedLabel(config.models.agent.defaultModelRef.split('/').pop() ?? '默认模型')
        }
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const groups = useMemo(() => buildModelSelectionGroups({ channels }), [channels])

  const filteredGroups: ModelOptionGroup[] = useMemo(() => {
    if (!search.trim()) return groups
    const q = search.toLowerCase()
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter(
          (o) => o.label.toLowerCase().includes(q) || o.modelId?.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.options.length > 0)
  }, [groups, search])

  const handleSelect = (option: ModelSelectionOption) => {
    onModelChange(option.modelRef, option.channelId, option.modelId)
    setSelectedLabel(option.label)
    setOpen(false)
    setSearch('')
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors text-[12px]"
        title="选择模型"
      >
        <Cpu size={14} />
        <span className="max-w-[80px] truncate">{selectedLabel}</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-64 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 bg-muted/50 rounded-md px-2 py-1">
              <Search size={12} className="text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模型..."
                className="flex-1 bg-transparent outline-none text-[12px] placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
          </div>
          <div className="max-h-[200px] overflow-y-auto p-1">
            {filteredGroups.map((group) => (
              <div key={group.id}>
                <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">{group.label}</div>
                {group.options.map((option) => (
                  <button
                    key={option.modelRef}
                    onClick={() => handleSelect(option)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] rounded-md hover:bg-muted/50 text-left transition-colors"
                  >
                    <ChannelProviderIcon provider={group.provider} size={14} />
                    <span className="truncate">{option.label}</span>
                  </button>
                ))}
              </div>
            ))}
            {filteredGroups.length === 0 && (
              <div className="px-2 py-3 text-[12px] text-muted-foreground text-center">无匹配模型</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
