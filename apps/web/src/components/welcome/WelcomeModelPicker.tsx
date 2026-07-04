import { useState, useRef, useEffect, useMemo } from 'react'
import { Box, ChevronDown, Search } from 'lucide-react'
import { listChannels } from '@/lib/desktop-api/channel'
import { buildModelSelectionGroups, getThreadSelectionSummary } from '@/components/model-selection/model-selection-state'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import { ModelOptionList } from '@/components/model-selection/ModelOptionList'
import type { ModelSelectionOption, ModelOptionGroup } from '@/components/model-selection/model-selection-state'
import type { Channel, LumeConfigAgentDefaultStrategy } from '@lume/shared'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'
import { cn } from '@/lib/utils'
import {
  composerControlChevronClassName,
  composerControlMenuClassName,
  composerControlTriggerClassName,
} from '@/components/agent/composer-control-styles'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
interface WelcomeModelPickerProps {
  onModelChange: (modelRef?: string, channelId?: string, modelId?: string) => void
  selectedChannelId?: string
  selectedModelRef?: string
  workspaceSlug?: string | null
  variant?: 'hero' | 'composer'
}

function findSelectedOption(
  groups: ModelOptionGroup[],
  input: { channelId?: string; modelRef?: string }
): ModelSelectionOption | undefined {
  const modelRef = input.modelRef?.trim()
  if (!modelRef) return undefined

  const channelGroups = input.channelId
    ? groups.filter((group) => group.id === input.channelId)
    : groups

  return channelGroups
    .flatMap((group) => group.options)
    .find((option) => option.modelRef === modelRef || option.modelId === modelRef)
}

function isDefaultModelOption(
  option: ModelSelectionOption,
  defaultStrategy: LumeConfigAgentDefaultStrategy
): boolean {
  const defaultModelRef = defaultStrategy.defaultModelRef?.trim()
  if (!defaultModelRef || option.modelRef !== defaultModelRef) return false

  const defaultChannelId = defaultStrategy.defaultChannelId?.trim()
  return !defaultChannelId || option.channelId === defaultChannelId
}

export function WelcomeModelPicker({
  onModelChange,
  selectedChannelId,
  selectedModelRef,
  workspaceSlug,
  variant = 'hero',
}: WelcomeModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelsLoaded, setChannelsLoaded] = useState(false)
  const [defaultStrategy, setDefaultStrategy] = useState<LumeConfigAgentDefaultStrategy>({})
  const [localChannelId, setLocalChannelId] = useState<string | undefined>()
  const [localModelRef, setLocalModelRef] = useState<string | undefined>()
  const menuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const onModelChangeRef = useRef(onModelChange)
  onModelChangeRef.current = onModelChange
  const propagatedInitial = useRef(false)

  useEffect(() => {
    propagatedInitial.current = false
    setChannelsLoaded(false)
    setLocalChannelId(undefined)
    setLocalModelRef(undefined)
    listChannels()
      .then((items) => setChannels(items))
      .catch(() => {})
      .finally(() => setChannelsLoaded(true))

    getEffectiveLumeConfig(workspaceSlug ?? undefined)
      .then((config) => {
        setDefaultStrategy(config.models?.agent ?? {})
      })
      .catch(() => {})
  }, [workspaceSlug])

  const activeChannelId = selectedChannelId ?? localChannelId
  const activeModelRef = selectedModelRef ?? localModelRef

  // 将默认模型传递给父组件
  useEffect(() => {
    if (propagatedInitial.current) return
    if (!channelsLoaded || channels.length === 0 || selectedModelRef) return

    const defaultGroups = buildModelSelectionGroups({
      channels,
      activeChannelId: defaultStrategy.defaultChannelId,
      activeModelRef: defaultStrategy.defaultModelRef,
    })

    // 先匹配配置的默认模型，再回退到第一个可用模型
    let option: ModelSelectionOption | undefined
    if (defaultStrategy.defaultModelRef) {
      option = findSelectedOption(defaultGroups, {
        channelId: defaultStrategy.defaultChannelId,
        modelRef: defaultStrategy.defaultModelRef,
      })
    }
    if (!option) {
      option = defaultGroups[0]?.options[0]
    }
    if (!option) return

    onModelChangeRef.current(
      option.modelRef,
      option.channelId,
      option.modelId
    )
    setLocalChannelId(option.channelId)
    setLocalModelRef(option.modelRef)
    propagatedInitial.current = true
  }, [channelsLoaded, channels, defaultStrategy, selectedModelRef])

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
    defaultStrategy: {
      ...defaultStrategy,
      ...(activeChannelId ? { defaultChannelId: activeChannelId } : {}),
      ...(activeModelRef ? { defaultModelRef: activeModelRef } : {}),
    },
  }), [activeChannelId, activeModelRef, channels, channelsLoaded, defaultStrategy])

  const handleSelect = (option: ModelSelectionOption) => {
    onModelChange(option.modelRef, option.channelId, option.modelId)
    setLocalChannelId(option.channelId)
    setLocalModelRef(option.modelRef)
    setOpen(false)
  }

  if (groups.length === 0 && !summary.label) {
    return null
  }

  const modelLabel = summary.label || '选择模型'
  const buttonClassName =
    variant === 'composer'
      ? composerControlTriggerClassName
      : 'inline-flex h-9 min-w-[168px] items-center gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_70%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] px-3 text-[13px] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_20%,var(--border-strong))] hover:text-[var(--text-1)]'
  const menuClassName =
    variant === 'composer'
      ? cn(composerControlMenuClassName, 'right-0 left-auto max-h-[320px] min-w-[300px] overflow-y-auto')
      : 'absolute left-0 top-full z-50 mt-3 min-w-[300px] max-h-[380px] overflow-y-auto rounded-[1.4rem] border border-[color:color-mix(in_oklab,var(--border-strong)_74%,transparent)] bg-[var(--surface-1)] shadow-[0_28px_52px_-34px_hsl(var(--shadow-panel)/0.48)]'

  return (
    <div className="relative flex items-center gap-1.5" ref={menuRef}>
      <Button
        variant="ghost"
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          buttonClassName,
          variant === 'hero' && open && 'border-[color:color-mix(in_oklab,var(--brand)_24%,var(--border-strong))] bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--surface-1))]',
        )}
        title="切换模型"
      >
        {variant === 'hero' ? (
          <Box size={15} className="shrink-0 text-[var(--text-2)]" />
        ) : activeChannel ? (
          <ChannelProviderIcon provider={activeChannel.provider} size={12} />
        ) : (
          <Box size={14} className="shrink-0 text-[var(--text-2)]" />
        )}
        {variant === 'hero' && <span className="shrink-0 text-[var(--text-2)]">模型：</span>}
        <span className={cn('min-w-0 truncate', variant === 'hero' ? 'flex-1 font-semibold text-[var(--text-1)]' : 'max-w-[160px]')}>
          {modelLabel}
        </span>
        <ChevronDown
          size={variant === 'hero' ? 13 : 12}
          className={cn('shrink-0', variant === 'hero' ? 'text-[var(--text-3)]' : composerControlChevronClassName)}
        />
      </Button>

      {open && (
        <div className={menuClassName}>
          <div className="border-b border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] p-3">
            <div className="flex items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_54%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] px-3 py-2">
              <Search size={13} className="shrink-0 text-[var(--text-3)]" />
              <Input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模型..."
                className="flex-1 border-0 bg-transparent px-0 text-[12px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
              />
            </div>
          </div>

          {filteredGroups.length > 0 ? (
            <ModelOptionList
              groups={filteredGroups}
              onSelect={handleSelect}
              renderBadge={(option) => (
                isDefaultModelOption(option, defaultStrategy)
                  ? (
                      <span className="shrink-0 rounded-full border border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_9%,var(--surface-1))] px-1.5 py-0.5 text-[10px] font-medium text-[var(--brand)]">
                        默认
                      </span>
                    )
                  : null
              )}
            />
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
