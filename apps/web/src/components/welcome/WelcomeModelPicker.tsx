import { useState, useRef, useEffect, useMemo } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { listChannels } from '@/lib/desktop-api/channel'
import { buildModelSelectionGroups, getThreadSelectionSummary } from '@/components/model-selection/model-selection-state'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import { ModelOptionList } from '@/components/model-selection/ModelOptionList'
import type { ModelSelectionOption, ModelOptionGroup } from '@/components/model-selection/model-selection-state'
import type { Channel, LumeConfigAgentDefaultStrategy } from '@lume/shared'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'

interface WelcomeModelPickerProps {
  onModelChange: (modelRef?: string, channelId?: string, modelId?: string) => void
}

export function WelcomeModelPicker({ onModelChange }: WelcomeModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelsLoaded, setChannelsLoaded] = useState(false)
  const [defaultStrategy, setDefaultStrategy] = useState<LumeConfigAgentDefaultStrategy>({})
  const [activeChannelId, setActiveChannelId] = useState<string | undefined>()
  const [activeModelRef, setActiveModelRef] = useState<string | undefined>()
  const menuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const onModelChangeRef = useRef(onModelChange)
  onModelChangeRef.current = onModelChange
  const propagatedInitial = useRef(false)

  useEffect(() => {
    listChannels()
      .then((items) => setChannels(items))
      .catch(() => {})
      .finally(() => setChannelsLoaded(true))

    getEffectiveLumeConfig()
      .then((config) => {
        const agent = config.models?.agent
        if (agent) {
          setDefaultStrategy(agent)
          setActiveChannelId(agent.defaultChannelId)
          setActiveModelRef(agent.defaultModelRef)
        }
      })
      .catch(() => {})
  }, [])

  // 将默认模型传递给父组件
  useEffect(() => {
    if (propagatedInitial.current) return
    if (!channelsLoaded || channels.length === 0 || !activeChannelId || !activeModelRef) return

    const channel = channels.find(c => c.id === activeChannelId)
    if (!channel) return

    const model = channel.models.find(m =>
      [m.id, `${channel.provider}/${m.id}`, `${channel.id}/${m.id}`].includes(activeModelRef!)
    )
    if (!model) return

    onModelChangeRef.current(
      `${channel.provider}/${model.id}`,
      channel.id,
      model.id
    )
    propagatedInitial.current = true
  }, [channelsLoaded, channels, activeChannelId, activeModelRef])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (open) {
      setSearch('')
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [open])

  const groups = useMemo(() => buildModelSelectionGroups({
    channels,
    activeChannelId,
    activeModelRef,
  }), [channels, activeChannelId, activeModelRef])

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

  const activeChannel = activeChannelId
    ? channels.find(c => c.id === activeChannelId)
    : undefined

  const summary = useMemo(() => getThreadSelectionSummary({
    channels,
    channelsLoaded,
    thread: undefined,
    defaultStrategy,
  }), [channels, channelsLoaded, defaultStrategy])

  const handleSelect = (option: ModelSelectionOption) => {
    onModelChange(option.modelRef, option.channelId, option.modelId)
    setActiveChannelId(option.channelId)
    setActiveModelRef(option.modelRef)
    setOpen(false)
  }

  if (groups.length === 0 && !summary.label) {
    return null
  }

  return (
    <div className="relative flex items-center gap-1.5" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-11 items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_62%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_92%,transparent)] px-4 text-[13px] font-medium text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:text-[var(--text-1)]"
        title="切换模型"
      >
        {activeChannel && (
          <ChannelProviderIcon provider={activeChannel.provider} size={11} />
        )}
        <span className="max-w-[220px] truncate">
          {activeChannel && summary.label
            ? `${activeChannel.name} / ${summary.label}`
            : summary.label}
        </span>
        <ChevronDown size={12} className="text-[var(--text-3)]" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-3 min-w-[300px] max-h-[380px] overflow-y-auto rounded-[1.4rem] border border-[color:color-mix(in_oklab,var(--border-strong)_74%,transparent)] bg-[var(--surface-1)] shadow-[0_28px_52px_-34px_hsl(var(--shadow-panel)/0.48)]">
          <div className="border-b border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] p-3">
            <div className="flex items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_54%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] px-3 py-2">
              <Search size={13} className="shrink-0 text-[var(--text-3)]" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模型..."
                className="flex-1 bg-transparent text-[12px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
              />
            </div>
          </div>

          {filteredGroups.length > 0 ? (
            <ModelOptionList groups={filteredGroups} onSelect={handleSelect} />
          ) : (
            <div className="py-6 text-center text-[12px] text-[var(--text-3)]">
              没有匹配的模型
            </div>
          )}
        </div>
      )}
    </div>
  )
}
