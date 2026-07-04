import * as React from 'react'
import { ArrowDown, ArrowUp, Loader2, Plus, RotateCcw, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Channel, LumeConfigAgentDefaultStrategy } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { listChannels } from '@/lib/desktop-api/channel'
import { getEffectiveLumeConfig, updateAgentModelStrategy } from '@/lib/desktop-api/lume-config'
import { ModelOptionList } from '@/components/model-selection/ModelOptionList'
import type { ModelOptionGroup } from '@/components/model-selection/model-selection-state'
import { buildModelSelectionGroups } from '@/components/model-selection/model-selection-state'

const EMPTY_SELECT_VALUE = '__empty__'

export interface ModelOption {
  channelId: string
  provider: string
  modelId: string
  modelRef: string
  label: string
  channelLabel: string
}

interface StrategyDraft {
  defaultModelRef?: string
  fallbackModelRefs: string[]
  hasExplicitDefaultModel: boolean
  unavailableDefaultModelRef?: string
  unavailableFallbackModelRefs: string[]
}

function normalizeOptional(value?: string | null): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function isChatModel(model: Channel['models'][number]): boolean {
  if (!model.enabled) {
    return false
  }
  return model.capabilities?.chat !== false
}

function buildModelRef(channel: Pick<Channel, 'provider'>, modelId: string): string {
  const trimmed = modelId.trim()
  const slashIndex = trimmed.indexOf('/')
  return slashIndex > 0 && slashIndex < trimmed.length - 1
    ? trimmed
    : `${channel.provider}/${trimmed}`
}

export function getEnabledChannels(channels: Channel[]): Channel[] {
  return channels.filter((channel) => channel.enabled && channel.models.some(isChatModel))
}

export function buildModelOptions(channels: Channel[], channelId?: string): ModelOption[] {
  const selectedChannels = channelId
    ? channels.filter((channel) => channel.id === channelId)
    : channels

  return selectedChannels.flatMap((channel) => (
    channel.models
      .filter(isChatModel)
      .map((model) => ({
        channelId: channel.id,
        provider: channel.provider,
        modelId: model.id,
        modelRef: buildModelRef(channel, model.id),
        label: model.name,
        channelLabel: channel.name,
      }))
  ))
}

function includesModelRef(options: ModelOption[], modelRef?: string): boolean {
  const normalized = normalizeOptional(modelRef)
  return normalized ? options.some((option) => option.modelRef === normalized) : false
}

export function sanitizeFallbackChain(input: {
  defaultModelRef?: string
  fallbackModelRefs: string[]
}): string[] {
  const seen = new Set<string>()
  const blocked = normalizeOptional(input.defaultModelRef)

  return input.fallbackModelRefs
    .map((item) => normalizeOptional(item))
    .filter((item): item is string => Boolean(item) && item !== blocked)
    .filter((item) => {
      if (seen.has(item)) {
        return false
      }
      seen.add(item)
      return true
    })
}

function normalizeFallbackEntries(fallbackModelRefs: string[]): string[] {
  return sanitizeFallbackChain({
    fallbackModelRefs,
  })
}

function normalizePersistedStrategy(
  strategy?: LumeConfigAgentDefaultStrategy
): LumeConfigAgentDefaultStrategy {
  const defaultChannelId = normalizeOptional(strategy?.defaultChannelId)
  const defaultModelRef = normalizeOptional(strategy?.defaultModelRef)
  const fallbackModelRefs = normalizeFallbackEntries(strategy?.fallbackModelRefs ?? [])

  return {
    ...(defaultChannelId ? { defaultChannelId } : {}),
    ...(defaultModelRef ? { defaultModelRef } : {}),
    ...(fallbackModelRefs.length > 0 ? { fallbackModelRefs } : {}),
  }
}

export function getDefaultStrategyDraft(input: {
  channels: Channel[]
  strategy?: LumeConfigAgentDefaultStrategy
}): StrategyDraft {
  const channels = getEnabledChannels(input.channels)
  const configuredChannelId = normalizeOptional(input.strategy?.defaultChannelId)
  const configuredModelRef = normalizeOptional(input.strategy?.defaultModelRef)
  const rawFallbacks = normalizeFallbackEntries(input.strategy?.fallbackModelRefs ?? [])
  const allModelOptions = buildModelOptions(channels)
  const fallbackDefaultModelRef = allModelOptions[0]?.modelRef
  const resolvedDefaultModelRef = includesModelRef(allModelOptions, configuredModelRef)
    ? configuredModelRef
    : fallbackDefaultModelRef

  return {
    defaultModelRef: resolvedDefaultModelRef,
    fallbackModelRefs: sanitizeFallbackChain({
      defaultModelRef: resolvedDefaultModelRef,
      fallbackModelRefs: rawFallbacks.filter((modelRef) => includesModelRef(allModelOptions, modelRef)),
    }),
    hasExplicitDefaultModel: Boolean(configuredModelRef),
    unavailableDefaultModelRef:
      configuredModelRef && configuredModelRef !== resolvedDefaultModelRef ? configuredModelRef : undefined,
    unavailableFallbackModelRefs: rawFallbacks.filter((modelRef) => (
      !includesModelRef(allModelOptions, modelRef)
      && modelRef !== configuredModelRef
      && modelRef !== configuredChannelId
    )),
  }
}

export function buildStrategySavePayload(
  draft: StrategyDraft,
  allModelOptions: ModelOption[]
): LumeConfigAgentDefaultStrategy {
  const defaultModelRef = normalizeOptional(draft.defaultModelRef)
  const selectedModel = defaultModelRef
    ? allModelOptions.find((option) => option.modelRef === defaultModelRef)
    : undefined
  const fallbackModelRefs = sanitizeFallbackChain({
    defaultModelRef,
    fallbackModelRefs: draft.fallbackModelRefs,
  })

  return {
    ...(draft.hasExplicitDefaultModel && selectedModel?.channelId ? { defaultChannelId: selectedModel.channelId } : {}),
    ...(draft.hasExplicitDefaultModel && defaultModelRef ? { defaultModelRef } : {}),
    ...(fallbackModelRefs.length > 0 ? { fallbackModelRefs } : {}),
  }
}

export function buildFallbackOptionGroups(
  options: ModelOption[],
  activeModelRef?: string
): ModelOptionGroup[] {
  const groups = new Map<string, ModelOptionGroup>()

  for (const option of options) {
    const existing = groups.get(option.channelId)
    if (existing) {
      existing.options.push({
        channelId: option.channelId,
        modelId: option.modelId,
        modelRef: option.modelRef,
        label: option.label,
        active: option.modelRef === activeModelRef,
      })
      continue
    }

    groups.set(option.channelId, {
      id: option.channelId,
      label: option.channelLabel,
      provider: option.provider,
      options: [{
        channelId: option.channelId,
        modelId: option.modelId,
        modelRef: option.modelRef,
        label: option.label,
        active: option.modelRef === activeModelRef,
      }],
    })
  }

  return Array.from(groups.values())
}

export function hasStrategyChanges(input: {
  persistedStrategy?: LumeConfigAgentDefaultStrategy
  draft: StrategyDraft
  allModelOptions: ModelOption[]
}): boolean {
  return JSON.stringify(normalizePersistedStrategy(input.persistedStrategy))
    !== JSON.stringify(buildStrategySavePayload(input.draft, input.allModelOptions))
}

export function getModelLabel(modelOptions: ModelOption[], modelRef?: string): string {
  const normalized = normalizeOptional(modelRef)
  if (!normalized) {
    return '未设置'
  }

  return modelOptions.find((option) => option.modelRef === normalized)?.label ?? normalized
}

function FallbackSelectRow(props: {
  value: string
  options: ModelOption[]
  unavailable?: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onChange: (value: string | null) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const groups = React.useMemo(
    () => buildFallbackOptionGroups(props.options, props.value),
    [props.options, props.value]
  )
  const activeOption = React.useMemo(
    () => props.options.find((option) => option.modelRef === props.value),
    [props.options, props.value]
  )

  React.useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div ref={menuRef} className="relative">
        <Button
                variant="ghost"
          type="button"
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'flex h-8 w-full items-center justify-between rounded-lg border border-input bg-transparent px-2.5 text-[13px] text-left transition-colors hover:bg-muted/30',
            props.unavailable && 'border-amber-500/50'
          )}
        >
          <span className="truncate">{activeOption?.label ?? props.value}</span>
          <span className="text-[11px] text-muted-foreground">{activeOption?.channelLabel ?? '未设置'}</span>
        </Button>

        {open && (
          <div className="absolute left-0 top-full z-50 mt-1 min-w-full overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg">
            <ModelOptionList
              groups={groups}
              onSelect={(option) => {
                setOpen(false)
                props.onChange(option.modelRef)
              }}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1">
        <Button size="icon-xs" variant="outline" onClick={props.onMoveUp} disabled={!props.canMoveUp}>
          <ArrowUp size={12} />
        </Button>
        <Button size="icon-xs" variant="outline" onClick={props.onMoveDown} disabled={!props.canMoveDown}>
          <ArrowDown size={12} />
        </Button>
        <Button size="icon-xs" variant="outline" onClick={props.onRemove}>
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
  )
}

export function DefaultModelStrategyPanel() {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [defaultModelOpen, setDefaultModelOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<StrategyDraft>({
    fallbackModelRefs: [],
    hasExplicitDefaultModel: false,
    unavailableFallbackModelRefs: [],
  })
  const [persistedStrategy, setPersistedStrategy] = React.useState<LumeConfigAgentDefaultStrategy>({})
  const defaultModelMenuRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    let cancelled = false

    Promise.all([listChannels(), getEffectiveLumeConfig()])
      .then(([loadedChannels, config]) => {
        if (cancelled) {
          return
        }

        const nextDraft = getDefaultStrategyDraft({
          channels: loadedChannels,
          strategy: config.models?.agent,
        })
        setChannels(loadedChannels)
        setDraft(nextDraft)
        setPersistedStrategy(normalizePersistedStrategy(config.models?.agent))
      })
      .catch((error) => {
        console.error('[DefaultModelStrategyPanel] 加载默认模型策略失败:', error)
        toast.error('加载默认模型策略失败')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (!defaultModelOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (defaultModelMenuRef.current && !defaultModelMenuRef.current.contains(event.target as Node)) {
        setDefaultModelOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [defaultModelOpen])

  const enabledChannels = React.useMemo(() => getEnabledChannels(channels), [channels])
  const allModelOptions = React.useMemo(() => buildModelOptions(enabledChannels), [enabledChannels])
  const activeDefaultModel = React.useMemo(
    () => allModelOptions.find((option) => option.modelRef === draft.defaultModelRef),
    [allModelOptions, draft.defaultModelRef]
  )
  const defaultModelGroups = React.useMemo(
    () => buildModelSelectionGroups({
      channels: enabledChannels,
      activeChannelId: activeDefaultModel?.channelId,
      activeModelRef: draft.defaultModelRef,
    }),
    [activeDefaultModel?.channelId, draft.defaultModelRef, enabledChannels]
  )
  const addableFallbackOptions = React.useMemo(
    () => allModelOptions.filter((option) => (
      option.modelRef !== draft.defaultModelRef
      && !draft.fallbackModelRefs.includes(option.modelRef)
    )),
    [allModelOptions, draft.defaultModelRef, draft.fallbackModelRefs]
  )
  const hasChanges = React.useMemo(
    () => hasStrategyChanges({ persistedStrategy, draft, allModelOptions }),
    [allModelOptions, draft, persistedStrategy]
  )

  const updateDraft = (recipe: (current: StrategyDraft) => StrategyDraft) => {
    setDraft((current) => recipe(current))
  }

  const handleDefaultModelChange = (value: string | null) => {
    const nextDefaultModelRef = value === EMPTY_SELECT_VALUE ? undefined : normalizeOptional(value)
    updateDraft((current) => ({
      ...current,
      defaultModelRef: nextDefaultModelRef,
      hasExplicitDefaultModel: true,
      fallbackModelRefs: sanitizeFallbackChain({
        defaultModelRef: nextDefaultModelRef,
        fallbackModelRefs: current.fallbackModelRefs,
      }),
      unavailableDefaultModelRef: undefined,
    }))
  }

  const handleDefaultModelSelect = (value: {
    modelRef: string
  }) => {
    setDefaultModelOpen(false)
    handleDefaultModelChange(value.modelRef)
  }

  const handleFallbackChange = (index: number, value: string | null) => {
    if (!value) {
      return
    }
    updateDraft((current) => {
      const fallbackModelRefs = current.fallbackModelRefs.map((item, itemIndex) => (
        itemIndex === index ? value : item
      ))
      return {
        ...current,
        fallbackModelRefs: sanitizeFallbackChain({
          defaultModelRef: current.defaultModelRef,
          fallbackModelRefs,
        }),
        unavailableFallbackModelRefs: current.unavailableFallbackModelRefs.filter((item) => item !== value),
      }
    })
  }

  const handleAddFallback = () => {
    const nextFallback = addableFallbackOptions[0]?.modelRef
    if (!nextFallback) {
      return
    }

    updateDraft((current) => ({
      ...current,
      fallbackModelRefs: [...current.fallbackModelRefs, nextFallback],
    }))
  }

  const moveFallback = (fromIndex: number, toIndex: number) => {
    updateDraft((current) => {
      if (toIndex < 0 || toIndex >= current.fallbackModelRefs.length) {
        return current
      }

      const fallbackModelRefs = [...current.fallbackModelRefs]
      const [item] = fallbackModelRefs.splice(fromIndex, 1)
      if (!item) {
        return current
      }
      fallbackModelRefs.splice(toIndex, 0, item)

      return {
        ...current,
        fallbackModelRefs,
      }
    })
  }

  const handleRemoveFallback = (index: number) => {
    updateDraft((current) => ({
      ...current,
      fallbackModelRefs: current.fallbackModelRefs.filter((_, itemIndex) => itemIndex !== index),
    }))
  }

  const handleReset = async () => {
    setSaving(true)
    try {
      await updateAgentModelStrategy({})
      const nextDraft = getDefaultStrategyDraft({ channels, strategy: {} })
      setDraft(nextDraft)
      setPersistedStrategy({})
      toast.success('默认模型策略已恢复默认')
    } catch (error) {
      console.error('[DefaultModelStrategyPanel] 重置默认模型策略失败:', error)
      toast.error('重置默认模型策略失败')
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const config = await updateAgentModelStrategy(buildStrategySavePayload(draft, allModelOptions))
      const nextDraft = getDefaultStrategyDraft({
        channels,
        strategy: config.models?.agent,
      })
      setDraft(nextDraft)
      setPersistedStrategy(normalizePersistedStrategy(config.models?.agent))
      toast.success('默认模型策略已保存')
    } catch (error) {
      console.error('[DefaultModelStrategyPanel] 保存默认模型策略失败:', error)
      toast.error('保存默认模型策略失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border bg-background/70 p-5">
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          加载默认模型策略...
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-2xl border bg-background/70 p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-[14px] font-semibold">默认模型策略</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            配置新线程默认使用的渠道、模型，以及按顺序尝试的回退链。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleReset} disabled={saving}>
            <RotateCcw size={13} />
            恢复默认
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !hasChanges}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            保存策略
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-[13px] font-medium">默认模型</Label>
        <div ref={defaultModelMenuRef} className="relative">
          <Button
                variant="ghost"
            type="button"
            onClick={() => setDefaultModelOpen((value) => !value)}
            className="flex h-8 w-full items-center justify-between rounded-lg border border-input bg-transparent px-2.5 text-[13px] text-left transition-colors hover:bg-muted/30"
          >
            <span className="truncate">
              {getModelLabel(allModelOptions, draft.defaultModelRef)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {activeDefaultModel?.channelLabel ?? '未设置'}
            </span>
          </Button>

          {defaultModelOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 min-w-full overflow-hidden rounded-lg border border-border/60 bg-popover shadow-lg">
              <ModelOptionList groups={defaultModelGroups} onSelect={handleDefaultModelSelect} />
            </div>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          默认模型本身已经包含 provider/model 渠道信息，不再单独配置默认渠道。
        </p>
        {draft.unavailableDefaultModelRef && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            已保存的默认模型 `{draft.unavailableDefaultModelRef}` 当前不可用，面板已切换到可用模型。
          </p>
        )}
      </div>

      <div className="space-y-3 rounded-xl border border-dashed p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Label className="text-[13px] font-medium">回退链</Label>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              当默认模型不可用时，将按这里的顺序继续尝试。默认模型不会被加入回退链。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleAddFallback} disabled={addableFallbackOptions.length === 0}>
            <Plus size={13} />
            添加回退模型
          </Button>
        </div>

        {draft.fallbackModelRefs.length > 0 ? (
          <div className="space-y-2">
            {draft.fallbackModelRefs.map((modelRef, index) => (
              <FallbackSelectRow
                key={`${modelRef}-${index}`}
                value={modelRef}
                options={allModelOptions.filter((option) => (
                  option.modelRef === modelRef
                  || (!draft.fallbackModelRefs.includes(option.modelRef) && option.modelRef !== draft.defaultModelRef)
                ))}
                canMoveUp={index > 0}
                canMoveDown={index < draft.fallbackModelRefs.length - 1}
                onChange={(value) => handleFallbackChange(index, value)}
                onMoveUp={() => moveFallback(index, index - 1)}
                onMoveDown={() => moveFallback(index, index + 1)}
                onRemove={() => handleRemoveFallback(index)}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
            还没有回退模型。添加后，系统会按顺序依次尝试这些候选项。
          </div>
        )}

        {draft.unavailableFallbackModelRefs.length > 0 && (
          <p className="text-[11px] text-amber-700 dark:text-amber-400">
            以下已保存的回退模型当前不可用，保存后会自动移除：
            {' '}
            {draft.unavailableFallbackModelRefs.join('，')}
          </p>
        )}
      </div>

      <div className="rounded-xl bg-muted/30 px-4 py-3 text-[12px] text-muted-foreground">
        当前默认模型：
        {' '}
        <span className="font-medium text-foreground">{getModelLabel(allModelOptions, draft.defaultModelRef)}</span>
        {' · '}
        回退顺序：
        {' '}
        {draft.fallbackModelRefs.length > 0
          ? draft.fallbackModelRefs.map((modelRef) => getModelLabel(allModelOptions, modelRef)).join(' → ')
          : '未设置'}
      </div>
    </div>
  )
}
