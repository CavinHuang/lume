import * as React from 'react'
import {
  Activity,
  Box,
  Check,
  ChevronDown,
  GripVertical,
  KeyRound,
  Loader2,
  Search,
  Trash2,
  X,
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
  MemoryRuntimeConfig,
  ProviderType,
  ProviderGroup,
} from '@lume/shared'
import {
  findModelMeta,
  formatContextWindow,
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
  PROVIDER_LABELS,
  PROVIDER_GROUPS,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { createChannel, decryptChannelKey, listChannels, updateChannel, deleteChannel } from '@/lib/desktop-api/channel'
import {
  getEffectiveLumeConfig,
  updateAgentModelStrategy,
  updateAgentThinkingLevel,
  updateEmbeddingModelRef,
  updateImageGenerationModelStrategy,
  updateMemoryExtractionModelRef,
  updateModelContextWindows,
  updateModelPurposeStrategy,
  updateRoutineModelStrategy,
  updateSubagentModelStrategy,
  type LumeModelPurpose,
} from '@/lib/desktop-api/lume-config'
import { getMemoryRuntimeConfig, updateMemoryRuntimeConfig } from '@/lib/desktop-api/memory'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import { ThinkingLevelPicker } from '@/components/agent/ThinkingLevelPicker'
import { ChannelForm } from './ChannelForm'
import { buildEmbeddingModelOptions, buildRerankModelOptions } from './memory-settings-state'
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

export function AgentSettings() {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [config, setConfig] = React.useState<LumeEffectiveConfig | null>(null)
  const [memoryRuntimeConfig, setMemoryRuntimeConfig] = React.useState<MemoryRuntimeConfig | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [savingModel, setSavingModel] = React.useState(false)
  const [savingAction, setSavingAction] = React.useState<string | null>(null)
  const [activeTab, setActiveTab] = React.useState<'providers' | 'actions'>('providers')
  const [thinkingLevel, setThinkingLevel] = React.useState<LumeConfigThinkingLevel>('medium')
  const [activeGroup, setActiveGroup] = React.useState<ProviderGroup>('all')
  const [providerSearch, setProviderSearch] = React.useState('')
  const [activeProvider, setActiveProvider] = React.useState<string>('anthropic')
  const [selectedApiKey, setSelectedApiKey] = React.useState('')
  const [contextModelRef, setContextModelRef] = React.useState('')
  const [contextWindowInput, setContextWindowInput] = React.useState('')
  const [apiKeyLoading, setApiKeyLoading] = React.useState(false)
  const [providerEnabled, setProviderEnabled] = React.useState(false)
  const [savingProvider, setSavingProvider] = React.useState(false)

  const reload = React.useCallback(async () => {
    const [nextChannels, nextConfig, nextMemoryRuntimeConfig] = await Promise.all([
      listChannels(),
      getEffectiveLumeConfig(),
      getMemoryRuntimeConfig(),
    ])
    setChannels(nextChannels)
    setConfig(nextConfig)
    setMemoryRuntimeConfig(nextMemoryRuntimeConfig)
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
  const embeddingOptions = React.useMemo(() => buildEmbeddingModelOptions(channels), [channels])
  const rerankOptions = React.useMemo(() => buildRerankModelOptions(channels), [channels])
  const imageOptions = React.useMemo(() => buildImageModelOptions(allModelOptions), [allModelOptions])
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
      // 分组过滤
      if (activeGroup !== 'all') {
        const groupInfo = PROVIDER_GROUPS.find(g => g.key === activeGroup)
        if (groupInfo && !groupInfo.providers.includes(row.provider)) return false
      }
      // 搜索过滤
      const query = providerSearch.trim().toLowerCase()
      const matchesSearch = !query
        || row.label.toLowerCase().includes(query)
        || row.provider.toLowerCase().includes(query)
      return matchesSearch
    }),
    [activeGroup, providerRows, providerSearch]
  )
  const activeProviderRow = React.useMemo(() => {
    // 自定义分组：通过 channelId 查找
    if (activeGroup === 'custom') {
      return providerRows.find((row) => row.channelId === activeProvider) ?? providerRows[0]
    }
    // 其他分组：通过 provider type 查找
    return providerRows.find((row) => row.provider === activeProvider && !row.channelId) ?? providerRows[0]
  }, [activeGroup, activeProvider, providerRows])
  const activeChannel = activeProviderRow?.channel ?? null
  const providerFormInitialValue = React.useMemo(
    () => getModelProviderFormInitialValue(
      activeProvider as ProviderType,
      channels,
      activeChannel ? selectedApiKey : '',
      activeProviderRow?.channelId
    ),
    [activeChannel, activeProvider, channels, selectedApiKey, activeProviderRow?.channelId]
  )

  React.useEffect(() => {
    const defaultProvider = activeDefault.channel?.provider
    if (defaultProvider && providerRows.some((row) => row.provider === defaultProvider && !row.channelId)) {
      setActiveProvider(defaultProvider)
      return
    }
    // 如果当前 activeProvider 不在当前分组的列表中，设置为第一个
    const groupInfo = PROVIDER_GROUPS.find(g => g.key === activeGroup)
    const firstInGroup = providerRows.find((row) => {
      if (activeGroup === 'custom') {
        return row.provider === 'custom' && row.channelId
      }
      if (activeGroup === 'all') {
        return !row.channelId
      }
      return groupInfo?.providers.includes(row.provider) && !row.channelId
    })
    if (firstInGroup && !providerRows.some((row) => (row.channelId ?? row.provider) === activeProvider)) {
      setActiveProvider(firstInGroup.channelId ?? firstInGroup.provider)
    }
    // activeProvider 故意不加入依赖——用户手动切换 provider 时不应被默认值覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDefault.channel?.provider, providerRows, activeGroup])

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

  const persistActionModel = async (action: string, modelRef: string) => {
    setSavingAction(action)
    try {
      if (action === 'subagent') {
        const nextConfig = await updateSubagentModelStrategy(modelRef ? { defaultModelRef: modelRef } : {})
        setConfig(nextConfig)
      } else if (action === 'routine') {
        const nextConfig = await updateRoutineModelStrategy(modelRef ? { defaultModelRef: modelRef } : {})
        setConfig(nextConfig)
      } else if (action === 'memory-extraction') {
        const nextConfig = await updateMemoryExtractionModelRef(modelRef.trim() || undefined)
        setConfig(nextConfig)
      } else if (action === 'embedding') {
        const nextConfig = await updateEmbeddingModelRef(modelRef || MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF)
        setConfig(nextConfig)
      } else if (action === 'rerank') {
        if (!memoryRuntimeConfig) return
        const nextConfig = await updateMemoryRuntimeConfig({
          retrieval: {
            ...memoryRuntimeConfig.retrieval,
            rerankModelRef: modelRef.trim() || undefined,
          },
        })
        setMemoryRuntimeConfig(nextConfig)
      } else if (isModelPurpose(action)) {
        const nextConfig = await updateModelPurposeStrategy(action, modelRef ? { defaultModelRef: modelRef } : {})
        setConfig(nextConfig)
      }
      toast.success('模型设置已更新')
    } catch (error) {
      console.error('[AgentSettings] save action model FAILED:', error)
      toast.error('保存模型设置失败')
    } finally {
      setSavingAction(null)
    }
  }

  const persistImageGeneration = async (next: { priorityModelRefs?: string[] }) => {
    setSavingAction('image-generation')
    try {
      const nextConfig = await updateImageGenerationModelStrategy(next)
      setConfig(nextConfig)
      toast.success('图像生成模型已更新')
    } catch (error) {
      console.error('[AgentSettings] save image generation models FAILED:', error)
      toast.error('保存图像生成模型失败')
    } finally {
      setSavingAction(null)
    }
  }

  const handleAddContextWindow = async () => {
    const modelRef = contextModelRef.trim()
    const tokens = Number(contextWindowInput.replace(/,/g, '').trim())
    if (!modelRef || !Number.isInteger(tokens) || tokens <= 0) {
      toast.error('请输入模型名和有效上下文长度')
      return
    }
    setSavingAction('context-windows')
    try {
      const nextConfig = await updateModelContextWindows({
        ...(config?.models?.contextWindows ?? {}),
        [modelRef]: tokens,
      })
      setConfig(nextConfig)
      setContextModelRef('')
      setContextWindowInput('')
      toast.success('上下文长度已更新')
    } catch (error) {
      console.error('[AgentSettings] save context window FAILED:', error)
      toast.error('保存上下文长度失败')
    } finally {
      setSavingAction(null)
    }
  }

  const handleRemoveContextWindow = async (modelRef: string) => {
    setSavingAction('context-windows')
    try {
      const next = { ...(config?.models?.contextWindows ?? {}) }
      delete next[modelRef]
      const nextConfig = await updateModelContextWindows(next)
      setConfig(nextConfig)
      toast.success('上下文长度已移除')
    } catch (error) {
      console.error('[AgentSettings] remove context window FAILED:', error)
      toast.error('移除上下文长度失败')
    } finally {
      setSavingAction(null)
    }
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
      <div className="flex items-center justify-between gap-3">
        <div className="flex rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-1">
          {[
            ['providers', '模型供应商'],
            ['actions', '模型设置'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id as 'providers' | 'actions')}
              className={cn(
                'h-8 rounded-[6px] px-3 text-[13px] font-medium transition-colors',
                activeTab === id
                  ? 'bg-[var(--surface-2)] text-[var(--text-1)] shadow-sm'
                  : 'text-[var(--text-3)] hover:text-[var(--text-1)]'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'providers' ? (
        <>
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
              activeGroup={activeGroup}
              providerEnabled={providerEnabled}
              providerSearch={providerSearch}
              savingProvider={savingProvider}
              onActiveProviderChange={setActiveProvider}
              onActiveGroupChange={setActiveGroup}
              onProviderSearchChange={setProviderSearch}
              onProviderEnabledChange={(checked) => void handleProviderEnabledChange(checked)}
              onProviderSubmit={persistProvider}
              onReload={reload}
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
        </>
      ) : (
        <ModelActionSettings
          chatOptions={allModelOptions}
          embeddingOptions={embeddingOptions}
          imageOptions={imageOptions}
          rerankOptions={rerankOptions}
          defaultModelValue={selectedModelValue}
          backgroundModelValue={config?.models?.background?.defaultModelRef ?? ''}
          contextCompressionModelValue={config?.models?.contextCompression?.defaultModelRef ?? ''}
          titleModelValue={config?.models?.title?.defaultModelRef ?? ''}
          welcomeSuggestionsModelValue={config?.models?.welcomeSuggestions?.defaultModelRef ?? ''}
          permissionClassifierModelValue={config?.models?.permissionClassifier?.defaultModelRef ?? ''}
          memoryJudgementModelValue={config?.models?.memoryJudgement?.defaultModelRef ?? ''}
          subagentModelValue={config?.models?.subagent?.defaultModelRef ?? ''}
          routineModelValue={config?.models?.routine?.defaultModelRef ?? ''}
          extractionModelValue={getMemoryExtractionModelRef(config)}
          embeddingModelValue={config?.models?.embedding?.defaultModelRef ?? ''}
          rerankModelValue={memoryRuntimeConfig?.retrieval.rerankModelRef ?? ''}
          imageGenerationValue={config?.models?.imageGeneration ?? {}}
          contextWindows={config?.models?.contextWindows ?? {}}
          contextModelRef={contextModelRef}
          contextWindowInput={contextWindowInput}
          savingAction={savingAction}
          savingModel={savingModel}
          onContextModelRefChange={setContextModelRef}
          onContextWindowInputChange={setContextWindowInput}
          onDefaultModelChange={(modelRef) => void persistDefaultModel(modelRef)}
          onActionModelChange={(action, modelRef) => void persistActionModel(action, modelRef)}
          onImageGenerationChange={(next) => void persistImageGeneration(next)}
          onAddContextWindow={() => void handleAddContextWindow()}
          onRemoveContextWindow={(modelRef) => void handleRemoveContextWindow(modelRef)}
        />
      )}
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

type ActionModelOption = {
  modelRef: string
  label: string
}

function ModelActionSettings({
  chatOptions,
  embeddingOptions,
  imageOptions,
  rerankOptions,
  defaultModelValue,
  backgroundModelValue,
  contextCompressionModelValue,
  titleModelValue,
  welcomeSuggestionsModelValue,
  permissionClassifierModelValue,
  memoryJudgementModelValue,
  subagentModelValue,
  routineModelValue,
  extractionModelValue,
  embeddingModelValue,
  rerankModelValue,
  imageGenerationValue,
  contextWindows,
  contextModelRef,
  contextWindowInput,
  savingAction,
  savingModel,
  onContextModelRefChange,
  onContextWindowInputChange,
  onDefaultModelChange,
  onActionModelChange,
  onImageGenerationChange,
  onAddContextWindow,
  onRemoveContextWindow,
}: {
  chatOptions: ActionModelOption[]
  embeddingOptions: ActionModelOption[]
  imageOptions: ActionModelOption[]
  rerankOptions: ActionModelOption[]
  defaultModelValue: string
  backgroundModelValue: string
  contextCompressionModelValue: string
  titleModelValue: string
  welcomeSuggestionsModelValue: string
  permissionClassifierModelValue: string
  memoryJudgementModelValue: string
  subagentModelValue: string
  routineModelValue: string
  extractionModelValue: string
  embeddingModelValue: string
  rerankModelValue: string
  imageGenerationValue: { priorityModelRefs?: string[] }
  contextWindows: Record<string, number>
  contextModelRef: string
  contextWindowInput: string
  savingAction: string | null
  savingModel: boolean
  onContextModelRefChange: (value: string) => void
  onContextWindowInputChange: (value: string) => void
  onDefaultModelChange: (modelRef: string) => void
  onActionModelChange: (action: string, modelRef: string) => void
  onImageGenerationChange: (value: { priorityModelRefs?: string[] }) => void
  onAddContextWindow: () => void
  onRemoveContextWindow: (modelRef: string) => void
}) {
  const inheritDefault = '与默认对话模型相同'
  const inheritBackground = '与轻量模型相同'

  return (
    <div className="space-y-3">
      <SettingsCard
        title="主力模型"
        description="核心对话、复杂推理和日程规划使用的模型。"
      >
        <ActionModelRow
          title="默认对话模型"
          description="主对话、新建话题时使用的模型"
          value={defaultModelValue}
          options={chatOptions}
          disabled={savingModel}
          onChange={onDefaultModelChange}
        />
        <ActionModelRow
          title="子 Agent"
          description="多任务并行场景中未指定时使用"
          value={subagentModelValue}
          options={chatOptions}
          inheritLabel={inheritDefault}
          disabled={savingAction === 'subagent'}
          onChange={(value) => onActionModelChange('subagent', value)}
        />
        <ActionModelRow
          title="日程调度"
          description="生成每日脚本、执行日程规划时使用"
          value={routineModelValue}
          options={chatOptions}
          inheritLabel={inheritDefault}
          disabled={savingAction === 'routine'}
          onChange={(value) => onActionModelChange('routine', value)}
        />
      </SettingsCard>

      <SettingsCard
        title="轻量后台任务"
        description="调用频繁但不需要强推理的任务。"
      >
        <ActionModelRow
          title="轻量模型"
          description="后台任务的默认模型"
          value={backgroundModelValue}
          options={chatOptions}
          inheritLabel={inheritDefault}
          disabled={savingAction === 'background'}
          onChange={(value) => onActionModelChange('background', value)}
        />
        <ActionModelRow
          title="上下文压缩"
          description="对话过长时自动摘要压缩"
          value={contextCompressionModelValue}
          options={chatOptions}
          inheritLabel={inheritBackground}
          disabled={savingAction === 'contextCompression'}
          onChange={(value) => onActionModelChange('contextCompression', value)}
        />
        <ActionModelRow
          title="标题生成"
          description="每次对话后自动生成会话标题"
          value={titleModelValue}
          options={chatOptions}
          inheritLabel={inheritBackground}
          disabled={savingAction === 'title'}
          onChange={(value) => onActionModelChange('title', value)}
        />
        <ActionModelRow
          title="欢迎建议"
          description="首页快捷建议的生成"
          value={welcomeSuggestionsModelValue}
          options={chatOptions}
          inheritLabel={inheritBackground}
          disabled={savingAction === 'welcomeSuggestions'}
          onChange={(value) => onActionModelChange('welcomeSuggestions', value)}
        />
        <ActionModelRow
          title="权限分类"
          description="无打扰模式下判断操作危险等级"
          value={permissionClassifierModelValue}
          options={chatOptions}
          inheritLabel={inheritBackground}
          disabled={savingAction === 'permissionClassifier'}
          onChange={(value) => onActionModelChange('permissionClassifier', value)}
        />
        <ActionModelRow
          title="记忆预判"
          description="对话结束后判断是否需要提取记忆"
          value={memoryJudgementModelValue}
          options={chatOptions}
          inheritLabel={inheritBackground}
          disabled={savingAction === 'memoryJudgement'}
          onChange={(value) => onActionModelChange('memoryJudgement', value)}
        />
      </SettingsCard>

      <SettingsCard
        title="记忆模型"
        description="记忆提取和重排使用的模型。"
      >
        <ActionModelRow
          title="记忆提取"
          description="每轮对话后提取用户记忆条目"
          value={extractionModelValue}
          options={chatOptions}
          inheritLabel={inheritDefault}
          disabled={savingAction === 'memory-extraction'}
          onChange={(value) => onActionModelChange('memory-extraction', value)}
        />
        <ActionModelRow
          title="记忆 Rerank"
          description="语义召回后对候选记忆重新排序"
          value={rerankModelValue}
          options={rerankOptions}
          inheritLabel="复用记忆提取模型"
          disabled={savingAction === 'rerank'}
          onChange={(value) => onActionModelChange('rerank', value)}
        />
      </SettingsCard>

      <SettingsCard
        title="Embedding 模型"
        description="全局语义嵌入默认模型，未单独设置时使用。"
      >
        <ActionModelRow
          title="默认 Embedding 模型"
          description="内置本地 bge-small-zh 开箱即用，也可切换云端 Embedding"
          value={embeddingModelValue}
          options={embeddingOptions}
          disabled={savingAction === 'embedding'}
          onChange={(value) => onActionModelChange('embedding', value)}
        />
      </SettingsCard>

      <ImageGenerationSettings
        options={imageOptions}
        value={imageGenerationValue}
        disabled={savingAction === 'image-generation'}
        onChange={onImageGenerationChange}
      />

      <ContextWindowSettings
        chatOptions={chatOptions}
        contextWindows={contextWindows}
        modelRef={contextModelRef}
        tokens={contextWindowInput}
        disabled={savingAction === 'context-windows'}
        onModelRefChange={onContextModelRefChange}
        onTokensChange={onContextWindowInputChange}
        onAdd={onAddContextWindow}
        onRemove={onRemoveContextWindow}
      />
    </div>
  )
}

function ActionModelRow({
  title,
  description,
  value,
  options,
  inheritLabel,
  disabled,
  onChange,
}: {
  title: string
  description: string
  value: string
  options: ActionModelOption[]
  inheritLabel?: string
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const hasCurrentOption = !value || options.some((option) => option.modelRef === value)

  return (
    <div className="grid min-h-[64px] grid-cols-[minmax(0,1fr)_minmax(220px,340px)] items-center gap-5 border-b border-[var(--border)] py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold leading-5 text-[var(--text-1)]">{title}</div>
        <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">{description}</div>
      </div>
      <SelectShell>
        <select
          value={value}
          disabled={disabled || (options.length === 0 && !inheritLabel)}
          onChange={(event) => onChange(event.target.value)}
          className="h-full w-full appearance-none bg-transparent pl-3 pr-8 text-[13px] font-medium text-[var(--text-1)] outline-none disabled:opacity-60"
        >
          {inheritLabel ? (
            <option value="">{inheritLabel}</option>
          ) : options.length === 0 ? (
            <option value="">未配置可用模型</option>
          ) : null}
          {value && !hasCurrentOption && <option value={value}>{value}</option>}
          {options.map((option) => (
            <option key={option.modelRef} value={option.modelRef}>{option.label}</option>
          ))}
        </select>
      </SelectShell>
    </div>
  )
}

function ImageGenerationSettings({
  options,
  value,
  disabled,
  onChange,
}: {
  options: ActionModelOption[]
  value: { priorityModelRefs?: string[] }
  disabled?: boolean
  onChange: (value: { priorityModelRefs?: string[] }) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [draggingRef, setDraggingRef] = React.useState<string | null>(null)
  const priority = value.priorityModelRefs ?? []
  const selected = new Set(priority)
  const filteredOptions = options.filter((option) => {
    const text = `${option.label} ${option.modelRef}`.toLowerCase()
    return text.includes(query.trim().toLowerCase())
  })

  const updatePriority = (priorityModelRefs: string[]) => onChange({
    ...value,
    priorityModelRefs,
  })
  const toggleModel = (modelRef: string) => {
    updatePriority(selected.has(modelRef)
      ? priority.filter((item) => item !== modelRef)
      : [...priority, modelRef])
  }
  const moveByDrop = (targetModelRef: string) => {
    if (!draggingRef || draggingRef === targetModelRef) return
    const from = priority.indexOf(draggingRef)
    const to = priority.indexOf(targetModelRef)
    if (from < 0 || to < 0) return
    updatePriority(moveItem(priority, from, to))
    setDraggingRef(null)
  }

  return (
    <SettingsCard
      title="图像生成模型优先级"
      description="选择并排序图像生成模型，失败时自动尝试下一个。"
    >
      <div className="space-y-3">
        <div
          className="relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
          }}
        >
          <span className="text-[12px] font-medium text-[var(--text-3)]">选择用于图像生成的模型</span>
          <button
            type="button"
            disabled={disabled || options.length === 0}
            onClick={() => setOpen((next) => !next)}
            className="mt-1 flex h-10 w-full items-center justify-between rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-left text-[13px] font-medium text-[var(--text-1)] outline-none transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_24%,var(--border))] disabled:opacity-60"
          >
            <span>{priority.length > 0 ? `已选 ${priority.length} 个模型` : '选择模型'}</span>
            <ChevronDown size={16} className={cn('text-[var(--text-3)] transition-transform', open && 'rotate-180')} />
          </button>
          {open && (
            <div className="absolute left-0 right-0 z-30 mt-2 overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_18px_42px_rgba(15,23,42,0.12)]">
              <div className="flex h-10 items-center gap-2 border-b border-[var(--border)] px-3">
                <Search size={15} className="text-[var(--text-3)]" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="过滤模型..."
                  className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
                />
              </div>
              <div className="max-h-[260px] overflow-y-auto">
                {filteredOptions.length === 0 ? (
                  <div className="px-3 py-4 text-[12px] text-[var(--text-3)]">没有匹配的模型</div>
                ) : filteredOptions.map((option) => (
                  <button
                    key={option.modelRef}
                    type="button"
                    onClick={() => toggleModel(option.modelRef)}
                    className="grid min-h-12 w-full grid-cols-[26px_minmax(0,1fr)] items-center gap-2 border-b border-[var(--border)] px-3 text-left last:border-b-0 hover:bg-[var(--surface-2)]"
                  >
                    <span className={cn(
                      'flex size-5 items-center justify-center rounded-[5px] border text-white',
                      selected.has(option.modelRef)
                        ? 'border-[var(--text-1)] bg-[var(--text-1)]'
                        : 'border-[var(--border-strong)] bg-transparent'
                    )}>
                      {selected.has(option.modelRef) && <Check size={14} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-[var(--text-1)]">{option.label}</span>
                      <span className="block truncate text-[12px] text-[var(--text-3)]">{option.modelRef}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-[12px] font-medium text-[var(--text-3)]">生成时的尝试顺序（拖拽调整）</div>
          {priority.length === 0 ? (
            <div className="rounded-[8px] border border-dashed border-[var(--border)] px-3 py-3 text-[12px] text-[var(--text-3)]">
              尚未选择图像生成模型
            </div>
          ) : priority.map((modelRef, index) => (
            <div
              key={modelRef}
              draggable={!disabled}
              onDragStart={(event) => {
                setDraggingRef(modelRef)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => moveByDrop(modelRef)}
              onDragEnd={() => setDraggingRef(null)}
              className={cn(
                'grid min-h-10 grid-cols-[24px_28px_minmax(0,1fr)_32px] items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3',
                draggingRef === modelRef && 'opacity-50'
              )}
            >
              <GripVertical size={15} className="cursor-grab text-[var(--text-3)]" />
              <span className="text-center text-[12px] font-semibold text-[var(--text-3)]">{index + 1}</span>
              <span className="truncate text-[13px] font-medium text-[var(--text-1)]">{getOptionLabel(options, modelRef)}</span>
              <button type="button" disabled={disabled} onClick={() => toggleModel(modelRef)} className="flex size-7 items-center justify-center rounded-[6px] text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[#ff4d57] disabled:opacity-40">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </SettingsCard>
  )
}

function ContextWindowSettings({
  chatOptions,
  contextWindows,
  modelRef,
  tokens,
  disabled,
  onModelRefChange,
  onTokensChange,
  onAdd,
  onRemove,
}: {
  chatOptions: ActionModelOption[]
  contextWindows: Record<string, number>
  modelRef: string
  tokens: string
  disabled?: boolean
  onModelRefChange: (value: string) => void
  onTokensChange: (value: string) => void
  onAdd: () => void
  onRemove: (modelRef: string) => void
}) {
  const rows = buildContextWindowRows(chatOptions, contextWindows)

  return (
    <SettingsCard
      title="模型上下文长度"
      description="查看和自定义各模型的最大上下文窗口。"
    >
      <div className="space-y-3">
        <div className="grid grid-cols-[minmax(0,1fr)_150px_72px] gap-2">
          <input
            value={modelRef}
            onChange={(event) => onModelRefChange(event.target.value)}
            placeholder="模型名（如 gpt-5.5）"
            className="h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
          />
          <input
            value={tokens}
            onChange={(event) => onTokensChange(event.target.value)}
            placeholder="128000"
            inputMode="numeric"
            className="h-9 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
          />
          <Button type="button" disabled={disabled} onClick={onAdd} className="h-9 rounded-[8px] text-[13px]">添加</Button>
        </div>

        <div className="max-h-[360px] overflow-y-auto rounded-[8px] border border-[var(--border)]">
          {rows.map((row) => (
            <div key={row.modelRef} className="grid min-h-11 grid-cols-[minmax(0,1fr)_86px_54px] items-center gap-2 border-b border-[var(--border)] px-3 last:border-b-0">
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold text-[var(--text-1)]">{row.modelRef}</div>
                <div className="truncate text-[11px] text-[var(--text-3)]">{row.label}</div>
              </div>
              <span className="justify-self-end rounded-[7px] border border-[var(--border)] px-2 py-1 text-[12px] font-semibold text-[var(--text-2)]">
                {formatContextWindow(row.tokens)}
              </span>
              {row.custom ? (
                <button type="button" disabled={disabled} onClick={() => onRemove(row.modelRef)} className="text-[12px] font-medium text-[#ff4d57] disabled:opacity-40">移除</button>
              ) : (
                <span className="text-right text-[11px] text-[var(--text-3)]">内置</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </SettingsCard>
  )
}

function ProviderConfigurationWorkbench({
  activeProvider,
  activeProviderRow,
  apiKeyLoading,
  filteredProviderRows,
  initialValue,
  activeGroup,
  providerEnabled,
  providerSearch,
  savingProvider,
  onActiveProviderChange,
  onActiveGroupChange,
  onProviderEnabledChange,
  onProviderSearchChange,
  onProviderSubmit,
  onReload,
}: {
  activeProvider: string
  activeProviderRow?: ModelProviderRow
  apiKeyLoading: boolean
  filteredProviderRows: ModelProviderRow[]
  initialValue: ChannelCreateInput
  activeGroup: ProviderGroup
  providerEnabled: boolean
  providerSearch: string
  savingProvider: boolean
  onActiveProviderChange: (id: string) => void
  onActiveGroupChange: (group: ProviderGroup) => void
  onProviderEnabledChange: (checked: boolean) => void
  onProviderSearchChange: (value: string) => void
  onProviderSubmit: (input: ChannelCreateInput) => Promise<void>
  onReload: () => void
}) {
  const activeChannel = activeProviderRow?.channel ?? null
  const activeLabel = activeProviderRow?.label ?? PROVIDER_LABELS[activeProvider as ProviderType]

  return (
    <div className="grid min-h-[365px] grid-cols-[282px_minmax(0,1fr)] items-stretch overflow-hidden rounded-[9px] border border-[var(--border)] bg-[var(--surface-1)]">
      <div className="relative min-h-0 rounded-l-[9px] border-r border-[var(--border)] bg-[var(--surface-1)]">
        <div className="absolute inset-0 flex min-h-0 flex-col p-4">
          {/* 分组标签栏 */}
          <div className="flex flex-wrap gap-1">
            {PROVIDER_GROUPS.map((group) => (
              <button
                key={group.key}
                type="button"
                onClick={() => onActiveGroupChange(group.key)}
                className={cn(
                  'rounded-[5px] px-2 py-1 text-[11px] font-medium transition-colors',
                  activeGroup === group.key
                    ? 'border border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                    : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
                )}
              >
                {group.label}
              </button>
            ))}
          </div>

          <div className="relative mt-2">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
            <input
              value={providerSearch}
              onChange={(event) => onProviderSearchChange(event.target.value)}
              placeholder="搜索供应商"
              className="h-8 w-full rounded-[7px] border border-[var(--border)] bg-[var(--surface-1)] pl-9 pr-3 text-[12px] font-medium text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
            />
          </div>

          <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {filteredProviderRows.map((row) => (
              <ProviderListItem
                key={row.channelId ?? row.provider}
                row={row}
                selected={activeProvider === (row.channelId ?? row.provider)}
                onClick={() => onActiveProviderChange(row.channelId ?? row.provider)}
                showDelete={activeGroup === 'custom'}
                onDelete={row.channel ? () => {
                  if (confirm(`确定删除 "${row.label}"？`)) {
                    deleteChannel(row.channel!.id).then(() => onReload())
                  }
                } : undefined}
              />
            ))}
          </div>

          {/* 自定义分组：添加按钮 */}
          {activeGroup === 'custom' && (
            <button
              type="button"
              onClick={() => {
                onActiveProviderChange('__new_custom__')
              }}
              className="mt-1 flex h-9 w-full items-center justify-center gap-1.5 rounded-[7px] border border-dashed border-[var(--border)] text-[12px] font-medium text-[var(--text-3)] hover:border-[var(--brand)] hover:text-[var(--brand)]"
            >
              <span className="text-[14px]">＋</span>
              添加自定义供应商
            </button>
          )}
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
              key={activeProviderRow?.channelId ?? activeProvider}
              mode={activeChannel ? 'edit' : 'create'}
              initialValue={initialValue}
              providerLocked={activeGroup !== 'custom'}
              disabled={!providerEnabled || savingProvider}
              onSubmit={onProviderSubmit}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function ProviderListItem({
  row,
  selected,
  showDelete,
  onDelete,
  onClick,
}: {
  row: ModelProviderRow
  selected: boolean
  showDelete?: boolean
  onDelete?: () => void
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
      {showDelete && onDelete ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onDelete() } }}
          className="text-[var(--text-3)] hover:text-[#ff4d57] cursor-pointer"
        >
          <Trash2 size={14} />
        </span>
      ) : (
        <ChevronDown size={14} className="-rotate-90 text-[var(--text-3)]" />
      )}
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

function getMemoryExtractionModelRef(config: LumeEffectiveConfig | null): string {
  const extraction = config?.memory?.extraction
  if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) return ''
  const modelRef = (extraction as Record<string, unknown>).modelRef
  return typeof modelRef === 'string' ? modelRef : ''
}

function isModelPurpose(value: string): value is LumeModelPurpose {
  return [
    'background',
    'contextCompression',
    'title',
    'welcomeSuggestions',
    'permissionClassifier',
    'memoryJudgement',
  ].includes(value)
}

function buildImageModelOptions(options: ModelOption[]): ActionModelOption[] {
  return options.filter((option) => {
    const text = `${option.modelRef} ${option.label}`.toLowerCase()
    return /image|seedream|flux|dall|gpt-image|imagen|stable|sdxl|mj|doubao.*vision/.test(text)
  })
}

function getOptionLabel(options: ActionModelOption[], modelRef: string): string {
  return options.find((option) => option.modelRef === modelRef)?.label ?? modelRef
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return items
  const next = [...items]
  const [item] = next.splice(from, 1)
  if (item === undefined) return items
  next.splice(to, 0, item)
  return next
}

function buildContextWindowRows(
  options: ActionModelOption[],
  overrides: Record<string, number>
): Array<{ modelRef: string; label: string; tokens: number; custom: boolean }> {
  const rows = new Map<string, { modelRef: string; label: string; tokens: number; custom: boolean }>()
  for (const option of options) {
    const meta = findModelMeta(option.modelRef)
    const tokens = overrides[option.modelRef] ?? meta?.contextWindow
    if (!tokens) continue
    rows.set(option.modelRef, {
      modelRef: option.modelRef,
      label: option.label,
      tokens,
      custom: overrides[option.modelRef] !== undefined,
    })
  }
  for (const [modelRef, tokens] of Object.entries(overrides)) {
    if (rows.has(modelRef)) continue
    rows.set(modelRef, {
      modelRef,
      label: modelRef,
      tokens,
      custom: true,
    })
  }
  return [...rows.values()].sort((left, right) => left.modelRef.localeCompare(right.modelRef))
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
