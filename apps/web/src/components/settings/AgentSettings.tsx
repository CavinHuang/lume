import * as React from 'react'
import {
  Activity,
  Box,
  ChevronDown,
  KeyRound,
  Loader2,
  Search,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  Channel,
  ChannelCreateInput,
  LumeConfigAgentDefaultStrategy,
  LumeConfigThinkingLevel,
  LumeEffectiveConfig,
  ProviderType,
} from '@lume/shared'
import { PROVIDER_LABELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { createChannel, decryptChannelKey, listChannels, updateChannel } from '@/lib/desktop-api/channel'
import { getEffectiveLumeConfig, updateAgentModelStrategy, updateAgentThinkingLevel } from '@/lib/desktop-api/lume-config'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import { ThinkingLevelPicker } from '@/components/agent/ThinkingLevelPicker'
import { ChannelForm } from './ChannelForm'
import {
  buildModelOptions,
  getEnabledChannels,
  type ModelOption,
} from './model-option-utils'
import {
  buildModelProviderRows,
  getModelProviderFormInitialValue,
  type ModelProviderRow,
} from './agent-settings-state'

type ProviderFilter = 'all' | 'configured' | 'unconfigured'

const MODEL_PROVIDER_QUICK_FILTERS: Array<[ProviderFilter, string]> = [
  ['all', '全部'],
  ['configured', '已配置'],
  ['unconfigured', '未配置'],
]

export function AgentSettings() {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [config, setConfig] = React.useState<LumeEffectiveConfig | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [savingModel, setSavingModel] = React.useState(false)
  const [thinkingLevel, setThinkingLevel] = React.useState<LumeConfigThinkingLevel>('medium')
  const [providerFilter, setProviderFilter] = React.useState<ProviderFilter>('all')
  const [providerSearch, setProviderSearch] = React.useState('')
  const [activeProvider, setActiveProvider] = React.useState<ProviderType>('anthropic')
  const [selectedApiKey, setSelectedApiKey] = React.useState('')
  const [apiKeyLoading, setApiKeyLoading] = React.useState(false)
  const [providerEnabled, setProviderEnabled] = React.useState(false)
  const [savingProvider, setSavingProvider] = React.useState(false)

  const reload = React.useCallback(async () => {
    const [nextChannels, nextConfig] = await Promise.all([
      listChannels(),
      getEffectiveLumeConfig(),
    ])
    setChannels(nextChannels)
    setConfig(nextConfig)
    const nextThinkingLevel = nextConfig.agent?.thinkingLevel ?? 'medium'
    setThinkingLevel(nextThinkingLevel)
  }, [])

  React.useEffect(() => {
    let cancelled = false

    reload()
      .catch((error) => {
        console.error('[AgentSettings] load FAILED:', error)
        toast.error('加载模型设置失败')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [reload])

  const enabledChannels = React.useMemo(() => getEnabledChannels(channels), [channels])
  const allModelOptions = React.useMemo(() => buildModelOptions(enabledChannels), [enabledChannels])
  const currentStrategy = config?.models?.agent ?? {}
  const activeDefault = React.useMemo(
    () => resolveDefaultModel({
      channels: enabledChannels,
      options: allModelOptions,
      strategy: currentStrategy,
    }),
    [allModelOptions, currentStrategy, enabledChannels]
  )
  const selectedProviderId = activeDefault.channel?.id ?? enabledChannels[0]?.id ?? ''
  const selectedProviderModels = React.useMemo(
    () => buildModelOptions(enabledChannels, selectedProviderId),
    [enabledChannels, selectedProviderId]
  )
  const selectedProviderValue = selectedProviderId
  const selectedModelValue = activeDefault.option?.modelRef ?? selectedProviderModels[0]?.modelRef ?? ''
  const providerRows = React.useMemo(() => buildModelProviderRows(channels), [channels])
  const connectedProviderCount = providerRows.filter((row) => row.channel?.enabled).length
  const availableModelCount = allModelOptions.length
  const defaultProviderLabel = activeDefault.channel?.name ?? activeDefault.option?.channelLabel ?? '未设置'
  const filteredProviderRows = React.useMemo(
    () => providerRows.filter((row) => {
      const matchesFilter = providerFilter === 'all'
        || (providerFilter === 'configured' && row.channel)
        || (providerFilter === 'unconfigured' && !row.channel)
      const query = providerSearch.trim().toLowerCase()
      const matchesSearch = !query
        || row.label.toLowerCase().includes(query)
        || row.provider.toLowerCase().includes(query)
      return matchesFilter && matchesSearch
    }),
    [providerFilter, providerRows, providerSearch]
  )
  const activeProviderRow = providerRows.find((row) => row.provider === activeProvider) ?? providerRows[0]
  const activeChannel = activeProviderRow?.channel ?? null
  const providerFormInitialValue = React.useMemo(
    () => getModelProviderFormInitialValue(activeProvider, channels, activeChannel ? selectedApiKey : ''),
    [activeChannel, activeProvider, channels, selectedApiKey]
  )

  React.useEffect(() => {
    const defaultProvider = activeDefault.channel?.provider
    if (defaultProvider && providerRows.some((row) => row.provider === defaultProvider)) {
      setActiveProvider(defaultProvider)
      return
    }
    if (!providerRows.some((row) => row.provider === activeProvider)) {
      setActiveProvider(providerRows[0]?.provider ?? 'anthropic')
    }
    // activeProvider 故意不加入依赖——用户手动切换 provider 时不应被默认值覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDefault.channel?.provider, providerRows])

  React.useEffect(() => {
    if (!activeChannel) {
      setSelectedApiKey('')
      setProviderEnabled(false)
      setApiKeyLoading(false)
      return
    }

    let cancelled = false
    setProviderEnabled(activeChannel.enabled)
    setApiKeyLoading(true)
    decryptChannelKey(activeChannel.id)
      .then((apiKey) => {
        if (!cancelled) setSelectedApiKey(apiKey)
      })
      .catch((error) => {
        console.error('[AgentSettings] decrypt channel key FAILED:', error)
        if (!cancelled) setSelectedApiKey('')
        toast.error('加载供应商密钥失败')
      })
      .finally(() => {
        if (!cancelled) setApiKeyLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeChannel?.id, activeChannel?.enabled])

  const persistDefaultModel = async (modelRef: string) => {
    const selected = allModelOptions.find((option) => option.modelRef === modelRef)
    if (!selected) return

    setSavingModel(true)
    try {
      const nextConfig = await updateAgentModelStrategy({
        ...currentStrategy,
        defaultChannelId: selected.channelId,
        defaultModelRef: selected.modelRef,
      })
      setConfig(nextConfig)
      toast.success('默认模型已更新')
    } catch (error) {
      console.error('[AgentSettings] save default model FAILED:', error)
      toast.error('保存默认模型失败')
    } finally {
      setSavingModel(false)
    }
  }

  const handleProviderChange = (channelId: string) => {
    const firstModel = buildModelOptions(enabledChannels, channelId)[0]
    if (firstModel) {
      void persistDefaultModel(firstModel.modelRef)
    }
  }

  const handleThinkingLevelChange = (value: LumeConfigThinkingLevel) => {
    setThinkingLevel(value)
    updateAgentThinkingLevel(value).catch((error) => {
      console.error('[AgentSettings] save thinking level FAILED:', error)
      toast.error('保存推理强度失败')
    })
  }

  const persistProvider = async (input: ChannelCreateInput) => {
    const payload = { ...input, enabled: providerEnabled }
    setSavingProvider(true)
    try {
      if (activeChannel) {
        const updated = await updateChannel(activeChannel.id, payload)
        setChannels((prev) => prev.map((channel) => (channel.id === updated.id ? updated : channel)))
        setSelectedApiKey(input.apiKey)
        setProviderEnabled(updated.enabled)
        toast.success('供应商配置已保存')
        return
      }

      const created = await createChannel(payload)
      setChannels((prev) => [...prev.filter((channel) => channel.provider !== created.provider), created])
      setSelectedApiKey(input.apiKey)
      setProviderEnabled(created.enabled)
      setActiveProvider(created.provider)
      toast.success('供应商配置已创建')
    } catch (error) {
      console.error('[AgentSettings] save provider FAILED:', error)
      toast.error('保存供应商配置失败')
      throw error
    } finally {
      setSavingProvider(false)
    }
  }

  const handleProviderEnabledChange = async (checked: boolean) => {
    setProviderEnabled(checked)
    if (!activeChannel) return

    setSavingProvider(true)
    try {
      const updated = await updateChannel(activeChannel.id, { enabled: checked })
      setChannels((prev) => prev.map((channel) => (channel.id === updated.id ? updated : channel)))
      toast.success(checked ? '供应商已启用' : '供应商已停用')
    } catch (error) {
      console.error('[AgentSettings] toggle provider FAILED:', error)
      setProviderEnabled(activeChannel.enabled)
      toast.error('更新供应商状态失败')
    } finally {
      setSavingProvider(false)
    }
  }

  const handleReset = async () => {
    setSavingModel(true)
    try {
      const nextConfig = await updateAgentModelStrategy({})
      setConfig(nextConfig)
      toast.success('模型设置已重置')
    } catch (error) {
      console.error('[AgentSettings] reset model settings FAILED:', error)
      toast.error('重置模型设置失败')
    } finally {
      setSavingModel(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-[280px] items-center justify-center rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] text-[13px] text-[var(--text-3)]">
        <Loader2 size={14} className="mr-2 animate-spin" />
        加载模型设置...
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <ModelProviderStats
        connectedProviderCount={connectedProviderCount}
        availableModelCount={availableModelCount}
        defaultProviderLabel={defaultProviderLabel}
      />

      <SettingsCard title="默认模型配置">
        <div className="grid grid-cols-[minmax(0,330px)_minmax(0,1fr)] items-center gap-x-14 gap-y-3">
          <div className="grid grid-cols-[104px_168px] items-center gap-x-8 gap-y-3">
            <FieldLabel>默认供应商</FieldLabel>
            <SelectShell>
              <select
                value={selectedProviderValue}
                onChange={(event) => handleProviderChange(event.target.value)}
                className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[var(--text-1)] outline-none"
              >
                {enabledChannels.length === 0 ? (
                  <option value="">未配置</option>
                ) : enabledChannels.map((channel) => (
                  <option key={channel.id} value={channel.id}>{channel.name}</option>
                ))}
              </select>
            </SelectShell>

            <FieldLabel>默认模型</FieldLabel>
            <SelectShell>
              <select
                value={selectedModelValue}
                onChange={(event) => void persistDefaultModel(event.target.value)}
                disabled={savingModel || selectedProviderModels.length === 0}
                className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[var(--text-1)] outline-none disabled:opacity-60"
              >
                {selectedProviderModels.length === 0 ? (
                  <option value="">未设置</option>
                ) : selectedProviderModels.map((option) => (
                  <option key={option.modelRef} value={option.modelRef}>{option.label}</option>
                ))}
              </select>
            </SelectShell>
          </div>

          <div className="grid grid-cols-[86px_minmax(0,260px)] items-start justify-end gap-x-4 gap-y-3">
            <FieldLabel className="justify-end">推理强度</FieldLabel>
            <ThinkingLevelPicker value={thinkingLevel} onChange={handleThinkingLevelChange} inline />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="供应商配置"
        description="供应商名称、Base URL、API Key 和模型列表会通过本地 channel 配置落盘。开启供应商后即可编辑并保存配置。"
      >
        <ProviderConfigurationWorkbench
          activeProvider={activeProvider}
          activeProviderRow={activeProviderRow}
          apiKeyLoading={apiKeyLoading}
          filteredProviderRows={filteredProviderRows}
          initialValue={providerFormInitialValue}
          providerFilter={providerFilter}
          providerEnabled={providerEnabled}
          providerSearch={providerSearch}
          savingProvider={savingProvider}
          onActiveProviderChange={setActiveProvider}
          onProviderFilterChange={setProviderFilter}
          onProviderSearchChange={setProviderSearch}
          onProviderEnabledChange={(checked) => void handleProviderEnabledChange(checked)}
          onProviderSubmit={persistProvider}
        />
      </SettingsCard>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleReset()}
          disabled={savingModel}
          className="h-10 gap-2 rounded-[8px] border-[#ffb8be] bg-[var(--surface-1)] px-4 text-[13px] font-medium text-[#ff4d57] shadow-none hover:bg-[#fff5f6] hover:text-[#ff4d57]"
        >
          <Trash2 size={15} />
          重置模型设置
        </Button>
      </div>
    </div>
  )
}

function ModelProviderStats({
  connectedProviderCount,
  availableModelCount,
  defaultProviderLabel,
}: {
  connectedProviderCount: number
  availableModelCount: number
  defaultProviderLabel: string
}) {
  const stats: Array<{
    icon: LucideIcon
    label: string
    value: string
    tone: string
    status?: 'success'
  }> = [
    { icon: KeyRound, label: '已连接供应商', value: String(connectedProviderCount), tone: 'bg-[color-mix(in_oklab,var(--brand)_15%,var(--surface-2))] text-[var(--brand)]' },
    { icon: Box, label: '可用模型', value: String(availableModelCount), tone: 'bg-[color-mix(in_oklab,oklch(0.55_0.2_260)_15%,var(--surface-2))] text-[oklch(0.55_0.2_260)]' },
    { icon: UserRound, label: '默认供应商', value: defaultProviderLabel, tone: 'bg-[color-mix(in_oklab,oklch(0.7_0.15_85)_15%,var(--surface-2))] text-[oklch(0.7_0.15_85)]' },
    { icon: Activity, label: '连接状态', value: connectedProviderCount > 0 ? '正常' : '待配置', tone: 'bg-[color-mix(in_oklab,oklch(0.65_0.2_145)_15%,var(--surface-2))] text-[oklch(0.65_0.2_145)]', status: 'success' },
  ]

  return (
    <section className="grid h-[78px] grid-cols-4 overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      {stats.map((stat, index) => {
        const Icon = stat.icon
        return (
          <div key={stat.label} className={cn('flex items-center gap-4 px-5', index > 0 && 'border-l border-[var(--border)]')}>
            <div className={cn('flex size-12 items-center justify-center rounded-full', stat.tone)}>
              <Icon size={21} strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-medium leading-4 text-[var(--text-2)]">{stat.label}</div>
              <div className={cn('mt-1 truncate text-[20px] font-semibold leading-6 text-[var(--text-1)]', stat.status === 'success' && 'text-[#18b969]')}>
                {stat.value}
              </div>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function ProviderConfigurationWorkbench({
  activeProvider,
  activeProviderRow,
  apiKeyLoading,
  filteredProviderRows,
  initialValue,
  providerFilter,
  providerEnabled,
  providerSearch,
  savingProvider,
  onActiveProviderChange,
  onProviderFilterChange,
  onProviderEnabledChange,
  onProviderSearchChange,
  onProviderSubmit,
}: {
  activeProvider: ProviderType
  activeProviderRow?: ProviderRowModel
  apiKeyLoading: boolean
  filteredProviderRows: ProviderRowModel[]
  initialValue: ChannelCreateInput
  providerFilter: ProviderFilter
  providerEnabled: boolean
  providerSearch: string
  savingProvider: boolean
  onActiveProviderChange: (provider: ProviderType) => void
  onProviderFilterChange: (filter: ProviderFilter) => void
  onProviderEnabledChange: (checked: boolean) => void
  onProviderSearchChange: (value: string) => void
  onProviderSubmit: (input: ChannelCreateInput) => Promise<void>
}) {
  const activeChannel = activeProviderRow?.channel ?? null
  const activeLabel = activeProviderRow?.label ?? PROVIDER_LABELS[activeProvider]

  return (
    <div className="grid min-h-[365px] grid-cols-[282px_minmax(0,1fr)] items-stretch overflow-hidden rounded-[9px] border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="relative min-h-0 rounded-l-[9px] border-r border-[var(--border)] bg-[var(--surface-1)]">
        <div className="absolute inset-0 flex min-h-0 flex-col p-4">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
            <input
              value={providerSearch}
              onChange={(event) => onProviderSearchChange(event.target.value)}
              placeholder="搜索供应商"
              className="h-8 w-full rounded-[7px] border border-[var(--border)] bg-[var(--surface-1)] pl-9 pr-3 text-[12px] font-medium text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
            />
          </div>

          <div className="mt-2 grid h-7 shrink-0 grid-cols-3 rounded-[7px] border border-[color-mix(in_oklab,var(--brand)_25%,var(--border-strong))] bg-[var(--surface-1)] p-0.5">
            {MODEL_PROVIDER_QUICK_FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => onProviderFilterChange(value)}
                className={cn(
                  'rounded-[5px] text-[12px] font-medium transition-colors',
                  providerFilter === value
                    ? 'border border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                    : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {filteredProviderRows.map((row) => (
              <ProviderListItem
                key={row.provider}
                row={row}
                selected={row.provider === activeProvider}
                onClick={() => onActiveProviderChange(row.provider)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="min-w-0 rounded-r-[9px] bg-[var(--surface-1)] p-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[15px] font-semibold leading-5 text-[var(--text-1)]">{activeLabel}</h3>
            <p className="mt-1 text-[12px] leading-4 text-[var(--text-3)]">
              {activeChannel ? '已存在该供应商配置，开启后可编辑并保存。' : '尚未配置该供应商，开启后即可填写连接信息。'}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-2)]">
            {savingProvider && <Loader2 size={13} className="animate-spin text-[var(--text-3)]" />}
            开启
            <LumeSwitch
              checked={providerEnabled}
              disabled={savingProvider}
              onCheckedChange={onProviderEnabledChange}
            />
          </div>
        </div>

        {apiKeyLoading ? (
          <div className="flex h-[290px] items-center gap-2 rounded-[9px] border border-[var(--border)] px-4 text-[13px] text-[var(--text-3)]">
            <Loader2 size={14} className="animate-spin" />
            加载供应商详情...
          </div>
        ) : (
          <div className="rounded-[9px] border border-[var(--border)] p-4">
            <ChannelForm
              key={activeProvider}
              mode={activeChannel ? 'edit' : 'create'}
              initialValue={initialValue}
              providerLocked
              disabled={!providerEnabled || savingProvider}
              onSubmit={onProviderSubmit}
            />
          </div>
        )}
      </div>
    </div>
  )
}

type ProviderRowModel = ModelProviderRow

function ProviderListItem({
  row,
  selected,
  onClick,
}: {
  row: ProviderRowModel
  selected: boolean
  onClick: () => void
}) {
  const configured = Boolean(row.channel)
  const connected = Boolean(row.channel?.enabled)

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'grid h-9 w-full grid-cols-[28px_minmax(0,1fr)_56px_14px] items-center gap-2 rounded-[7px] border px-2 text-left transition-colors',
        selected
          ? 'border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
          : 'border-transparent bg-[var(--surface-1)] text-[#3d465d] hover:border-[var(--border)]'
      )}
    >
      <span className={cn('flex size-6 items-center justify-center rounded-[6px]', row.tone)}>
        <ChannelProviderIcon provider={row.provider} size={14} />
      </span>
      <span className="truncate text-[12px] font-semibold">{row.label}</span>
      <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--text-2)]">
        <span className={cn('size-1.5 rounded-full', connected ? 'bg-[#22c76f]' : configured ? 'bg-[var(--text-3)]' : 'bg-[#b8c0cf]')} />
        {configured ? '已配置' : '未配置'}
      </span>
      <ChevronDown size={14} className="-rotate-90 text-[var(--text-3)]" />
    </button>
  )
}

function SettingsCard({
  title,
  description,
  action,
  children,
}: {
  title?: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      {(title || action) && (
        <div className="mb-3 flex min-h-8 items-start justify-between gap-4">
          <div className="min-w-0">
            {title && <h2 className="text-[16px] font-semibold leading-6 text-[var(--text-1)]">{title}</h2>}
            {description && <p className="mt-0.5 text-[11px] font-medium leading-4 text-[var(--text-3)]">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-9 items-center text-[13px] font-medium text-[var(--text-2)]', className)}>{children}</div>
  )
}

function SelectShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('relative h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)]', className)}>
      {children}
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]"
      />
    </div>
  )
}

function LumeSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      className={cn(
        'data-[size=default]:h-[18px] data-[size=default]:w-[32px] data-checked:bg-[var(--brand)] data-unchecked:bg-[#d8dee9]',
        '[&_[data-slot=switch-thumb]]:size-[14px] data-checked:[&_[data-slot=switch-thumb]]:translate-x-[14px]'
      )}
    />
  )
}

function resolveDefaultModel(input: {
  channels: Channel[]
  options: ModelOption[]
  strategy?: LumeConfigAgentDefaultStrategy
}): { option: ModelOption | null; channel: Channel | null } {
  const configuredModelRef = input.strategy?.defaultModelRef?.trim()
  const fallbackOption = input.options[0] ?? null
  const option = configuredModelRef
    ? input.options.find((item) => item.modelRef === configuredModelRef) ?? fallbackOption
    : fallbackOption
  const channel = option
    ? input.channels.find((item) => item.id === option.channelId) ?? null
    : null

  return { option, channel }
}
