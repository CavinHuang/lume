import * as React from 'react'
import {
  Activity,
  Box,
  ChevronDown,
  Copy,
  Eye,
  FileUp,
  Info,
  KeyRound,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
  UserRound,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  Channel,
  LumeConfigAgentDefaultStrategy,
  LumeConfigThinkingLevel,
  LumeEffectiveConfig,
  ProviderType,
} from '@lume/shared'
import { PROVIDER_DEFAULT_URLS, PROVIDER_LABELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { listChannels } from '@/lib/desktop-api/channel'
import { getEffectiveLumeConfig, updateAgentModelStrategy } from '@/lib/desktop-api/lume-config'
import { sidecarCall } from '@/lib/desktop-api'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import {
  buildModelOptions,
  getEnabledChannels,
  type ModelOption,
} from './model-option-utils'

type ReasoningTone = 'low' | 'medium' | 'high'
type ContextStrategy = 'balanced' | 'large' | 'cheap'
type RateLimit = 'normal' | 'fast' | 'safe'
type Timeout = '30' | '60' | '120'
type ProviderFilter = 'all' | 'configured' | 'unconfigured'

const MODEL_PROVIDER_QUICK_FILTERS: Array<[ProviderFilter, string]> = [
  ['all', '全部'],
  ['configured', '已配置'],
  ['unconfigured', '未配置'],
]

const MODEL_PROVIDER_ROWS: Array<{
  provider: ProviderType
  label: string
  tone: string
}> = [
  { provider: 'openai', label: 'OpenAI', tone: 'bg-[#efe9ff] text-[#7a54f2]' },
  { provider: 'anthropic', label: 'Anthropic', tone: 'bg-[#f5e4b8] text-[#6e5928]' },
  { provider: 'google', label: 'Google AI', tone: 'bg-[#e6f0ff] text-[#346df1]' },
  { provider: 'deepseek', label: 'DeepSeek', tone: 'bg-[#e9f1ff] text-[#3a65e5]' },
  { provider: 'openrouter', label: 'OpenRouter', tone: 'bg-[#eff4ff] text-[#111827]' },
  { provider: 'custom', label: '自定义供应商', tone: 'bg-[#eadcff] text-[#7a52e8]' },
  { provider: 'zai', label: '智谱 Z.ai', tone: 'bg-[#eee7ff] text-[#7557ff]' },
  { provider: 'moonshot', label: 'Moonshot / Kimi', tone: 'bg-[#111827] text-white' },
]

const PREVIEW_MODELS: Partial<Record<ProviderType, string[]>> = {
  zai: ['glm-4.5', 'glm-4.6', 'glm-5', 'glm-4.5-air', 'glm-4.7', 'glm-5-flash'],
  openai: ['gpt-5.1', 'gpt-5.4', 'gpt-5.4-mini', 'o4-mini'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  google: ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  moonshot: ['kimi-k2', 'kimi-thinking-preview'],
}

export function AgentSettings() {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [config, setConfig] = React.useState<LumeEffectiveConfig | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [savingModel, setSavingModel] = React.useState(false)
  const [reasoningTone, setReasoningTone] = React.useState<ReasoningTone>('medium')
  const [contextStrategy, setContextStrategy] = React.useState<ContextStrategy>('balanced')
  const [preferDefault, setPreferDefault] = React.useState(true)
  const [autoFallback, setAutoFallback] = React.useState(true)
  const [rateLimit, setRateLimit] = React.useState<RateLimit>('normal')
  const [timeout, setTimeout] = React.useState<Timeout>('60')
  const [costNotice, setCostNotice] = React.useState(true)
  const [providerFilter, setProviderFilter] = React.useState<ProviderFilter>('all')
  const [providerSearch, setProviderSearch] = React.useState('')
  const [activeProvider, setActiveProvider] = React.useState<ProviderType>('zai')

  const reload = React.useCallback(async () => {
    const [nextChannels, nextConfig] = await Promise.all([
      listChannels(),
      getEffectiveLumeConfig(),
    ])
    setChannels(nextChannels)
    setConfig(nextConfig)
    const nextThinkingLevel = nextConfig.agent?.thinkingLevel ?? 'medium'
    setReasoningTone(toReasoningTone(nextThinkingLevel))
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
  const providerRows = React.useMemo(
    () => MODEL_PROVIDER_ROWS.map((row) => ({
      ...row,
      channel: channels.find((channel) => channel.provider === row.provider) ?? null,
    })),
    [channels]
  )
  const connectedProviderCount = providerRows.filter((row) => row.channel?.enabled).length
  const availableModelCount = allModelOptions.length
  const defaultProviderLabel = activeDefault.channel?.name ?? activeDefault.option?.channelLabel ?? '未设置'
  const fallbackProviders = React.useMemo(
    () => getFallbackProviderLabels(currentStrategy.fallbackModelRefs ?? [], allModelOptions, activeDefault.option),
    [activeDefault.option, allModelOptions, currentStrategy.fallbackModelRefs]
  )
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

  React.useEffect(() => {
    const defaultProvider = activeDefault.channel?.provider
    if (defaultProvider && providerRows.some((row) => row.provider === defaultProvider)) {
      setActiveProvider(defaultProvider)
    }
  }, [activeDefault.channel?.provider, providerRows])

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

  const handleReasoningToneChange = (value: ReasoningTone) => {
    const nextThinkingLevel = toThinkingLevel(value)
    setReasoningTone(value)
    sidecarCall('lume-config:update-section', {
      source: 'user',
      path: 'agent.thinkingLevel',
      value: nextThinkingLevel,
      summary: 'update agent thinking level',
    }).catch((error) => {
      console.error('[AgentSettings] save thinking level FAILED:', error)
      toast.error('保存推理强度失败')
    })
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
      <div className="flex h-[280px] items-center justify-center rounded-[10px] border border-[#e7e9f1] bg-white text-[13px] text-[#7c8398]">
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

      <SettingsCard
        title="默认模型配置"
        action={(
          <Button
            type="button"
            variant="outline"
            onClick={() => toast.success('默认配置可用')}
            className="h-8 gap-2 rounded-[8px] border-[#e1e5ee] bg-white px-3 text-[12px] font-medium text-[#566078] shadow-none hover:bg-[#f8f9fc]"
          >
            <Activity size={14} />
            测试默认配置
          </Button>
        )}
      >
        <div className="grid grid-cols-[minmax(0,330px)_minmax(0,1fr)] items-center gap-x-14 gap-y-3">
          <div className="grid grid-cols-[104px_168px] items-center gap-x-8 gap-y-3">
            <FieldLabel>默认供应商</FieldLabel>
            <SelectShell>
              <select
                value={selectedProviderValue}
                onChange={(event) => handleProviderChange(event.target.value)}
                className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#273044] outline-none"
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
                className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#273044] outline-none disabled:opacity-60"
              >
                {selectedProviderModels.length === 0 ? (
                  <option value="">未设置</option>
                ) : selectedProviderModels.map((option) => (
                  <option key={option.modelRef} value={option.modelRef}>{option.label}</option>
                ))}
              </select>
            </SelectShell>
          </div>

          <div className="grid grid-cols-[86px_minmax(0,230px)] items-center justify-end gap-x-4 gap-y-3">
            <FieldLabel className="justify-end">推理强度</FieldLabel>
            <SegmentedControl
              value={reasoningTone}
              options={[
                ['low', '轻量'],
                ['medium', '标准'],
                ['high', '深入'],
              ]}
              onChange={(value) => handleReasoningToneChange(value as ReasoningTone)}
            />

            <FieldLabel className="justify-end">上下文策略</FieldLabel>
            <SegmentedControl
              value={contextStrategy}
              options={[
                ['balanced', '平衡'],
                ['large', '大上下文'],
                ['cheap', '低成本'],
              ]}
              onChange={(value) => setContextStrategy(value as ContextStrategy)}
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="请求与路由策略">
        <div className="grid grid-cols-[296px_1px_minmax(0,1fr)] gap-8">
          <div className="space-y-2.5">
            <ToggleRow label="优先使用默认供应商" checked={preferDefault} onCheckedChange={setPreferDefault} />
            <ToggleRow label="默认供应商失败时自动回退" checked={autoFallback} onCheckedChange={setAutoFallback} />
            <ToggleRow label="成本提示" checked={costNotice} onCheckedChange={setCostNotice} />
          </div>
          <div className="bg-[#edf0f6]" />
          <div className="grid grid-cols-[86px_minmax(0,1fr)_86px_204px] items-center gap-x-4 gap-y-3">
            <FieldLabel>回退顺序</FieldLabel>
            <FallbackChipSelect labels={fallbackProviders} />
            <div />
            <div />

            <FieldLabel>速率限制</FieldLabel>
            <SelectShell className="w-[178px]">
              <select
                value={rateLimit}
                onChange={(event) => setRateLimit(event.target.value as RateLimit)}
                className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#4c566f] outline-none"
              >
                <option value="normal">标准</option>
                <option value="fast">高吞吐</option>
                <option value="safe">保守</option>
              </select>
            </SelectShell>
            <FieldLabel>请求超时</FieldLabel>
            <SelectShell className="w-full">
              <select
                value={timeout}
                onChange={(event) => setTimeout(event.target.value as Timeout)}
                className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#4c566f] outline-none"
              >
                <option value="30">30 秒</option>
                <option value="60">60 秒</option>
                <option value="120">120 秒</option>
              </select>
            </SelectShell>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="供应商配置"
        action={(
          <div className="flex items-center gap-2">
            <Button variant="outline" className="h-8 gap-2 rounded-[8px] border-[#e1e5ee] bg-white px-4 text-[12px] font-medium text-[#566078] shadow-none hover:bg-[#f8f9fc]">
              <Upload size={14} />
              导入配置
            </Button>
            <Button className="h-8 gap-2 rounded-[8px] bg-[#625bff] px-4 text-[12px] font-medium text-white shadow-none hover:bg-[#5a52f2]">
              <Plus size={14} />
              添加供应商
            </Button>
          </div>
        )}
      >
        <ProviderConfigurationWorkbench
          activeProvider={activeProvider}
          activeProviderRow={activeProviderRow}
          filteredProviderRows={filteredProviderRows}
          providerFilter={providerFilter}
          providerSearch={providerSearch}
          onActiveProviderChange={setActiveProvider}
          onProviderFilterChange={setProviderFilter}
          onProviderSearchChange={setProviderSearch}
          timeout={timeout}
        />
      </SettingsCard>

      <div className="grid grid-cols-3 gap-4">
        <FooterAction icon={FileUp} label="导出配置" />
        <FooterAction icon={Waves} label="检查全部连接" />
        <FooterAction icon={Trash2} label="重置模型设置" tone="danger" onClick={() => void handleReset()} />
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
    { icon: KeyRound, label: '已连接供应商', value: String(connectedProviderCount), tone: 'bg-[#efe9ff] text-[#7657ff]' },
    { icon: Box, label: '可用模型', value: String(availableModelCount), tone: 'bg-[#eaf2ff] text-[#347cff]' },
    { icon: UserRound, label: '默认供应商', value: defaultProviderLabel, tone: 'bg-[#fff1cc] text-[#e39516]' },
    { icon: Activity, label: '连接状态', value: connectedProviderCount > 0 ? '正常' : '待配置', tone: 'bg-[#dcf9e8] text-[#1fbd65]', status: 'success' },
  ]

  return (
    <section className="grid h-[78px] grid-cols-4 overflow-hidden rounded-[10px] border border-[#e7e9f1] bg-white shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      {stats.map((stat, index) => {
        const Icon = stat.icon
        return (
          <div key={stat.label} className={cn('flex items-center gap-4 px-5', index > 0 && 'border-l border-[#edf0f6]')}>
            <div className={cn('flex size-12 items-center justify-center rounded-full', stat.tone)}>
              <Icon size={21} strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-medium leading-4 text-[#6f7890]">{stat.label}</div>
              <div className={cn('mt-1 truncate text-[20px] font-semibold leading-6 text-[#11182f]', stat.status === 'success' && 'text-[#18b969]')}>
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
  filteredProviderRows,
  providerFilter,
  providerSearch,
  onActiveProviderChange,
  onProviderFilterChange,
  onProviderSearchChange,
  timeout,
}: {
  activeProvider: ProviderType
  activeProviderRow?: ProviderRowModel
  filteredProviderRows: ProviderRowModel[]
  providerFilter: ProviderFilter
  providerSearch: string
  onActiveProviderChange: (provider: ProviderType) => void
  onProviderFilterChange: (filter: ProviderFilter) => void
  onProviderSearchChange: (value: string) => void
  timeout: Timeout
}) {
  const activeChannel = activeProviderRow?.channel ?? null
  const models = getWorkbenchModels(activeProvider, activeChannel)
  const activeLabel = activeProviderRow?.label ?? PROVIDER_LABELS[activeProvider]
  const baseUrl = activeChannel?.baseUrl || PROVIDER_DEFAULT_URLS[activeProvider] || ''
  const displayName = activeChannel?.name || activeLabel

  return (
    <div className="grid min-h-[365px] grid-cols-[282px_minmax(0,1fr)] overflow-hidden rounded-[9px] border border-[#e4e8f0] bg-white">
      <div className="border-r border-[#e7ebf3] bg-[#fbfcff] p-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#96a0b5]" />
          <input
            value={providerSearch}
            onChange={(event) => onProviderSearchChange(event.target.value)}
            placeholder="搜索供应商"
            className="h-8 w-full rounded-[7px] border border-[#e1e6ef] bg-white pl-9 pr-3 text-[12px] font-medium text-[#283046] outline-none placeholder:text-[#9aa3b6]"
          />
        </div>

        <div className="mt-2 grid h-7 grid-cols-3 rounded-[7px] border border-[#d8dcff] bg-white p-0.5">
          {MODEL_PROVIDER_QUICK_FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onProviderFilterChange(value)}
              className={cn(
                'rounded-[5px] text-[12px] font-medium transition-colors',
                providerFilter === value
                  ? 'border border-[#9f91ff] bg-[#f5f2ff] text-[#625bff]'
                  : 'text-[#667089] hover:bg-[#f7f8fb]'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-2 max-h-[288px] space-y-1.5 overflow-y-auto pr-1">
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

      <div className="p-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[15px] font-semibold leading-5 text-[#1f2638]">{activeLabel}</h3>
            <p className="mt-1 text-[12px] leading-4 text-[#7d869a]">
              {activeChannel ? '已存在该供应商配置，开启后可编辑并保存。' : '尚未配置该供应商，开启后即可填写连接信息。'}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[12px] font-medium text-[#6f7890]">
            已启用
            <LumeSwitch checked={Boolean(activeChannel?.enabled)} onCheckedChange={() => undefined} />
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_308px] gap-6">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <FieldBlock label="供应商">
                <SelectShell>
                  <select
                    value={activeProvider}
                    onChange={(event) => onActiveProviderChange(event.target.value as ProviderType)}
                    className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#273044] outline-none"
                  >
                    {MODEL_PROVIDER_ROWS.map((row) => (
                      <option key={row.provider} value={row.provider}>{row.label}</option>
                    ))}
                  </select>
                </SelectShell>
              </FieldBlock>
              <FieldBlock label="名称">
                <FieldInput value={displayName} />
              </FieldBlock>
            </div>

            <FieldBlock label="Base URL">
              <FieldInput value={baseUrl} mono />
            </FieldBlock>

            <FieldBlock label="API Key">
              <div className="grid h-9 grid-cols-[minmax(0,1fr)_36px_36px] rounded-[8px] border border-[#e1e6ef] bg-white">
                <input
                  value={activeChannel ? '••••••••••••••••••••••••••••••••••••••' : ''}
                  readOnly
                  placeholder="sk-..."
                  className="min-w-0 bg-transparent px-3 font-mono text-[12px] font-medium text-[#273044] outline-none placeholder:text-[#9aa3b6]"
                />
                <button type="button" className="flex items-center justify-center border-l border-[#e1e6ef] text-[#7e879b] hover:bg-[#f8f9fc]">
                  <Eye size={14} />
                </button>
                <button type="button" className="flex items-center justify-center border-l border-[#e1e6ef] text-[#7e879b] hover:bg-[#f8f9fc]">
                  <Copy size={14} />
                </button>
              </div>
            </FieldBlock>
          </div>

          <FieldBlock label="模型选择">
            <div className="overflow-hidden rounded-[8px] border border-[#e1e6ef] bg-white">
              <div className="flex h-9 items-center gap-2 border-b border-[#eef1f6] px-3">
                <Search size={14} className="text-[#8a94aa]" />
                <input
                  readOnly
                  value=""
                  placeholder="搜索模型"
                  className="min-w-0 flex-1 bg-transparent text-[12px] font-medium outline-none placeholder:text-[#9aa3b6]"
                />
                <button type="button" className="h-7 rounded-[6px] border border-[#d8dcff] bg-white px-2 text-[12px] font-medium text-[#625bff]">
                  拉取模型列表
                </button>
              </div>
              <div className="max-h-[134px] space-y-1 overflow-y-auto p-2">
                {models.map((model) => (
                  <label key={model} className="flex h-6 items-center gap-2 text-[12px] font-mono text-[#3f485e]">
                    <input type="checkbox" checked readOnly className="size-3.5 accent-[#625bff]" />
                    <span className="truncate">{model}</span>
                  </label>
                ))}
              </div>
            </div>
          </FieldBlock>
        </div>

        <div className="mt-3 rounded-[9px] border border-[#e4e8f0] p-3">
          <div className="mb-3 text-[13px] font-semibold leading-5 text-[#202338]">高级选项</div>
          <div className="grid grid-cols-[130px_1fr_88px_204px] items-center gap-x-5">
            <ToggleRow label="作为默认供应商" checked={false} onCheckedChange={() => undefined} muted />
            <Button variant="outline" className="h-9 gap-2 rounded-[8px] border-[#e1e5ee] bg-white px-4 text-[12px] font-medium text-[#566078] shadow-none hover:bg-[#f8f9fc]">
              <Activity size={14} />
              测试连接
            </Button>
            <FieldLabel>请求超时</FieldLabel>
            <SelectShell>
              <select
                value={timeout}
                onChange={() => undefined}
                className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[#4c566f] outline-none"
              >
                <option value="30">30 秒</option>
                <option value="60">60 秒</option>
                <option value="120">120 秒</option>
              </select>
            </SelectShell>
          </div>
          <div className="mt-3 flex h-8 items-center gap-2 rounded-[7px] bg-[#f0efff] px-3 text-[12px] font-medium text-[#625bff]">
            <Info size={14} />
            填写配置信息后点击下方保存，未开启时不会提交该供应商配置。
          </div>
        </div>
      </div>
    </div>
  )
}

type ProviderRowModel = (typeof MODEL_PROVIDER_ROWS)[number] & { channel: Channel | null }

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
          ? 'border-[#9f91ff] bg-[#f5f2ff] text-[#625bff]'
          : 'border-transparent bg-white text-[#3d465d] hover:border-[#e3e7f0]'
      )}
    >
      <span className={cn('flex size-6 items-center justify-center rounded-[6px]', row.tone)}>
        <ChannelProviderIcon provider={row.provider} size={14} />
      </span>
      <span className="truncate text-[12px] font-semibold">{row.label}</span>
      <span className="flex items-center gap-1 text-[11px] font-medium text-[#667089]">
        <span className={cn('size-1.5 rounded-full', connected ? 'bg-[#22c76f]' : configured ? 'bg-[#9aa3b6]' : 'bg-[#b8c0cf]')} />
        {configured ? '已配置' : '未配置'}
      </span>
      <ChevronDown size={14} className="-rotate-90 text-[#98a1b5]" />
    </button>
  )
}

function SettingsCard({
  title,
  action,
  children,
}: {
  title?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[10px] border border-[#e7e9f1] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      {(title || action) && (
        <div className="mb-3 flex min-h-8 items-center justify-between gap-4">
          {title && <h2 className="text-[16px] font-semibold leading-6 text-[#202338]">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-9 items-center text-[13px] font-medium text-[#59637a]', className)}>{children}</div>
  )
}

function FieldBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold leading-4 text-[#59637a]">{label}</span>
      {children}
    </label>
  )
}

function FieldInput({ value, mono = false }: { value: string; mono?: boolean }) {
  return (
    <input
      value={value}
      readOnly
      className={cn(
        'h-9 w-full rounded-[8px] border border-[#e1e6ef] bg-white px-3 text-[13px] font-medium text-[#273044] outline-none',
        mono && 'font-mono text-[12px]'
      )}
    />
  )
}

function SelectShell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('relative h-9 rounded-[8px] border border-[#e3e6ee] bg-white', className)}>
      {children}
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#778096]"
      />
    </div>
  )
}

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<[string, string]>
  onChange: (value: string) => void
}) {
  return (
    <div className="grid h-9 w-full grid-cols-3 rounded-[8px] border border-[#e3e6ee] bg-white p-0.5">
      {options.map(([optionValue, label]) => (
        <button
          key={optionValue}
          type="button"
          onClick={() => onChange(optionValue)}
          className={cn(
            'rounded-[6px] text-[13px] font-medium transition-colors',
            value === optionValue
              ? 'border border-[#9f91ff] bg-[#f5f2ff] text-[#625bff]'
              : 'text-[#667089] hover:bg-[#f7f8fb]'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function FallbackChipSelect({ labels }: { labels: string[] }) {
  return (
    <div className="col-span-3 flex h-9 min-w-0 items-center gap-1.5 rounded-[8px] border border-[#e3e7f0] bg-white px-2">
      {labels.length > 0 ? labels.map((label) => (
        <span
          key={label}
          className="inline-flex h-6 min-w-0 items-center gap-1 rounded-[6px] bg-[#f0efff] px-2 text-[12px] font-medium text-[#625bff]"
        >
          <span className="truncate">{label}</span>
          <X size={12} className="shrink-0 text-[#8d84ff]" />
        </span>
      )) : (
        <span className="text-[12px] text-[#9aa1b3]">未设置回退供应商</span>
      )}
      <ChevronDown size={14} className="ml-auto shrink-0 text-[#8a91a6]" />
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  muted = false,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  muted?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex h-7 items-center justify-between gap-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-[#59637a]">
        <span>{label}</span>
        {muted && <Info size={13} className="text-[#9aa3b6]" />}
      </div>
      <LumeSwitch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function LumeSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      className={cn(
        'data-[size=default]:h-[18px] data-[size=default]:w-[32px] data-checked:bg-[#625bff] data-unchecked:bg-[#d8dee9]',
        '[&_[data-slot=switch-thumb]]:size-[14px] data-checked:[&_[data-slot=switch-thumb]]:translate-x-[14px]'
      )}
    />
  )
}

function FooterAction({
  icon: Icon,
  label,
  tone = 'default',
  onClick,
}: {
  icon: LucideIcon
  label: string
  tone?: 'default' | 'danger'
  onClick?: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={cn(
        'h-11 gap-2 rounded-[8px] border-[#e3e6ee] bg-white text-[13px] font-medium text-[#4d566f] shadow-none hover:bg-[#f8f9fc]',
        tone === 'danger' && 'border-[#ffb8be] text-[#ff4d57] hover:bg-[#fff5f6] hover:text-[#ff4d57]'
      )}
    >
      <Icon size={15} />
      {label}
    </Button>
  )
}

function getWorkbenchModels(provider: ProviderType, channel: Channel | null): string[] {
  const channelModels = channel?.models
    .filter((model) => model.capabilities?.chat !== false)
    .map((model) => model.id)

  if (channelModels && channelModels.length > 0) {
    return channelModels.slice(0, 8)
  }

  return PREVIEW_MODELS[provider] ?? ['model-1', 'model-2', 'model-3']
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

function getFallbackProviderLabels(
  fallbackModelRefs: string[],
  modelOptions: ModelOption[],
  activeModel: ModelOption | null
): string[] {
  const labels = fallbackModelRefs
    .map((modelRef) => modelOptions.find((option) => option.modelRef === modelRef)?.channelLabel)
    .filter((label): label is string => Boolean(label))

  if (labels.length > 0) {
    return Array.from(new Set(labels)).slice(0, 3)
  }

  return Array.from(new Set(
    modelOptions
      .filter((option) => option.channelId !== activeModel?.channelId)
      .map((option) => option.channelLabel)
  )).slice(0, 3)
}

function toReasoningTone(value: LumeConfigThinkingLevel): ReasoningTone {
  if (value === 'low' || value === 'off') {
    return 'low'
  }
  if (value === 'high' || value === 'max') {
    return 'high'
  }
  return 'medium'
}

function toThinkingLevel(value: ReasoningTone): LumeConfigThinkingLevel {
  if (value === 'low') return 'low'
  if (value === 'high') return 'high'
  return 'medium'
}
