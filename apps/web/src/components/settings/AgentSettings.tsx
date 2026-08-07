import * as React from 'react'
import {
  Activity,
  Brain,
  Box,
  Check,
  ChevronDown,
  Eye,
  GripVertical,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  UserRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { AnimatePresence, motion } from 'framer-motion'
import type {
  Channel,
  ChannelCreateInput,
  LumeConfigAgentDefaultStrategy,
  LumeConfigThinkingLevel,
  LumeEffectiveConfig,
  MemoryRuntimeConfig,
  ModelMeta,
  ProviderType,
  ProviderGroup,
  ReadingAdvancedModelSettings,
  ReadingSettings,
} from '@lume/shared'
import {
  findModelMeta,
  formatContextWindow,
  formatPricing,
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
  PROVIDER_GROUPS,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { useModelMetaReload, useModelMetaVersion } from '@/lib/model-meta-context'
import { createChannel, listChannels, updateChannel, deleteChannel } from '@/lib/desktop-api/channel'
import {
  getEffectiveLumeConfig,
  updateAgentModelStrategy,
  updateAgentThinkingLevel,
  updateAutomationModelStrategy,
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
import { syncModelMeta } from '@/lib/desktop-api/model'
import { getReadingSnapshot, updateReadingSettings } from '@/lib/desktop-api/reading'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import { ThinkingLevelPicker } from '@/components/agent/ThinkingLevelPicker'
import { ChannelForm } from './ChannelForm'
import { ConnectionSetupSheet } from './ConnectionSetupSheet'
import { DefaultModelStrategyPanel } from './DefaultModelStrategyPanel'
import { buildEmbeddingModelOptions, buildRerankModelOptions } from './memory-settings-state'
import { buildReadingModelPatch, READING_ADVANCED_STAGE_OPTIONS, type ReadingModelField } from './reading-settings-state'
import {
  buildModelOptions,
  findModelOption,
  getEnabledChannels,
  isConnectionReady,
  type ModelOption,
} from './model-option-utils'
import {
  buildModelProviderRows,
  getModelProviderFormInitialValue,
  type ModelProviderRow,
} from './agent-settings-state'

import { Input } from '@/components/ui/input'
export function AgentSettings() {
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [config, setConfig] = React.useState<LumeEffectiveConfig | null>(null)
  const [memoryRuntimeConfig, setMemoryRuntimeConfig] = React.useState<MemoryRuntimeConfig | null>(null)
  const [readingSettings, setReadingSettings] = React.useState<ReadingSettings | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [savingModel, setSavingModel] = React.useState(false)
  const [savingAction, setSavingAction] = React.useState<string | null>(null)
  const [activeTab, setActiveTab] = React.useState<'connections' | 'models' | 'routing'>('connections')
  const [connectionSetupOpen, setConnectionSetupOpen] = React.useState(false)
  const [thinkingLevel, setThinkingLevel] = React.useState<LumeConfigThinkingLevel>('medium')
  const [activeGroup, setActiveGroup] = React.useState<ProviderGroup>('all')
  const [providerSearch, setProviderSearch] = React.useState('')
  const [activeProvider, setActiveProvider] = React.useState<string>('')
  const [selectedApiKey, setSelectedApiKey] = React.useState('')
  const [contextModelRef, setContextModelRef] = React.useState('')
  const [contextWindowInput, setContextWindowInput] = React.useState('')
  const apiKeyLoading = false
  const [providerEnabled, setProviderEnabled] = React.useState(false)
  const [savingProvider, setSavingProvider] = React.useState(false)
  const [syncingModelMeta, setSyncingModelMeta] = React.useState(false)
  const reloadModelMeta = useModelMetaReload()

  const reload = React.useCallback(async () => {
    const [nextChannels, nextConfig, nextMemoryRuntimeConfig, nextReadingSnapshot] = await Promise.all([
      listChannels(),
      getEffectiveLumeConfig(),
      getMemoryRuntimeConfig(),
      getReadingSnapshot(),
    ])
    setChannels(nextChannels)
    setConfig(nextConfig)
    setMemoryRuntimeConfig(nextMemoryRuntimeConfig)
    setReadingSettings(nextReadingSnapshot.settings)
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
  const providerRows = React.useMemo(() => buildModelProviderRows(channels), [channels])
  const connectedProviderCount = channels.filter(isConnectionReady).length
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
    return providerRows.find((row) => row.channelId === activeProvider)
      ?? providerRows[0]
  }, [activeProvider, providerRows])
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

  // 展开项完全由用户手动控制——不自动展开默认/首个 provider，避免数据刷新或保存时强制跳转、覆盖用户当前的展开/收起选择

  React.useEffect(() => {
    if (!activeChannel) {
      setSelectedApiKey('')
      setProviderEnabled(false)
      return
    }
    setProviderEnabled(activeChannel.enabled)
    setSelectedApiKey('')
  }, [activeChannel?.id, activeChannel?.enabled])

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
      } else if (action === 'automation') {
        const nextConfig = await updateAutomationModelStrategy(modelRef ? { defaultModelRef: modelRef } : {})
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

  const persistReadingModel = async (field: ReadingModelField, modelRef: string) => {
    setSavingAction(`reading-${field}`)
    try {
      const updated = await updateReadingSettings(buildReadingModelPatch(field, modelRef))
      setReadingSettings(updated)
      toast.success('读书模型已更新')
    } catch (error) {
      console.error('[AgentSettings] save reading model FAILED:', error)
      toast.error('保存读书模型失败')
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

  const handleSyncModelMeta = async () => {
    setSyncingModelMeta(true)
    try {
      const generated = await syncModelMeta()
      await reloadModelMeta(generated)
      toast.success(`已更新 ${generated.length} 个模型信息`)
    } catch (error) {
      console.error('[AgentSettings] syncModelMeta FAILED:', error)
      toast.error(`更新模型信息失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSyncingModelMeta(false)
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
      setChannels((prev) => [...prev, created])
      setSelectedApiKey(input.apiKey)
      setProviderEnabled(created.enabled)
      setActiveProvider(created.id)
      toast.success('供应商配置已创建')
    } catch (error) {
      console.error('[AgentSettings] save provider FAILED:', error)
      toast.error('保存供应商配置失败')
      throw error
    } finally {
      setSavingProvider(false)
    }
  }

  // 按 channelId 乐观切换启用状态：折叠行开关与展开态 header 开关共用此原语
  const updateChannelEnabled = async (channelId: string, checked: boolean): Promise<boolean> => {
    const original = channels.find((c) => c.id === channelId)
    if (!original) return false
    setChannels((prev) => prev.map((c) => (c.id === channelId ? { ...c, enabled: checked } : c)))
    try {
      const updated = await updateChannel(channelId, { enabled: checked })
      setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
      return true
    } catch (error) {
      console.error('[AgentSettings] toggle channel enabled FAILED:', error)
      setChannels((prev) => prev.map((c) => (c.id === channelId ? { ...c, enabled: original.enabled } : c)))
      return false
    }
  }

  // 折叠行开关：不触碰 savingProvider，避免影响当前展开行的表单禁用态
  const handleToggleChannelEnabled = async (channelId: string, checked: boolean) => {
    const ok = await updateChannelEnabled(channelId, checked)
    if (ok) toast.success(checked ? '供应商已启用' : '供应商已停用')
    else toast.error('更新供应商状态失败')
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
      <div className="lume-panel flex h-[280px] items-center justify-center text-[13px] text-[var(--text-3)]">
        <Loader2 size={14} className="mr-2 animate-spin" />
        加载模型设置...
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="lume-segmented flex">
          {[
            ['connections', '连接'],
            ['models', '模型'],
            ['routing', '用途与路由'],
          ].map(([id, label]) => (
            <Button
              variant="ghost"
              key={id}
              type="button"
              onClick={() => setActiveTab(id as 'connections' | 'models' | 'routing')}
              className={cn(
                'lume-segmented-item',
                activeTab === id
                  ? 'lume-segmented-item-active'
                  : ''
              )}
            >
              {label}
            </Button>
          ))}
        </div>
        {activeTab === 'connections' && (
          <Button type="button" onClick={() => setConnectionSetupOpen(true)} className="gap-2">
            <Plus size={14} />
            添加连接
          </Button>
        )}
      </div>

      {activeTab === 'connections' ? (
        <>
          <ModelProviderStats
            connectedProviderCount={connectedProviderCount}
            availableModelCount={availableModelCount}
            defaultProviderLabel={defaultProviderLabel}
          />

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
              providerSearch={providerSearch}
              savingProvider={savingProvider}
              onActiveProviderChange={setActiveProvider}
              onActiveGroupChange={setActiveGroup}
              onProviderSearchChange={setProviderSearch}
              onToggleChannelEnabled={handleToggleChannelEnabled}
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
              className="h-10 gap-2 rounded-[8px] border-[color:color-mix(in_oklab,var(--lume-danger)_34%,var(--border))] bg-[var(--surface-1)] px-4 text-[13px] font-medium text-[var(--lume-danger)] shadow-none hover:bg-[color:color-mix(in_oklab,var(--lume-danger)_8%,var(--surface-1))] hover:text-[var(--lume-danger)]"
            >
              <Trash2 size={15} />
              重置模型设置
            </Button>
          </div>
        </>
      ) : activeTab === 'models' ? (
        <ModelCatalogPanel
          channels={channels}
          onToggleModel={async (connectionId, modelId, enabled) => {
            const channel = channels.find((item) => item.id === connectionId)
            if (!channel) return
            const updated = await updateChannel(connectionId, {
              models: channel.models.map((model) => model.id === modelId ? { ...model, enabled } : model),
            })
            setChannels((current) => current.map((item) => item.id === updated.id ? updated : item))
          }}
        />
      ) : (
        <div className="space-y-4">
          <DefaultModelStrategyPanel />
          <ModelActionSettings
          chatOptions={allModelOptions}
          embeddingOptions={embeddingOptions}
          imageOptions={imageOptions}
          rerankOptions={rerankOptions}
          backgroundModelValue={config?.models?.background?.defaultModelRef ?? ''}
          contextCompressionModelValue={config?.models?.contextCompression?.defaultModelRef ?? ''}
          titleModelValue={config?.models?.title?.defaultModelRef ?? ''}
          welcomeSuggestionsModelValue={config?.models?.welcomeSuggestions?.defaultModelRef ?? ''}
          permissionClassifierModelValue={config?.models?.permissionClassifier?.defaultModelRef ?? ''}
          memoryJudgementModelValue={config?.models?.memoryJudgement?.defaultModelRef ?? ''}
          subagentModelValue={config?.models?.subagent?.defaultModelRef ?? ''}
          routineModelValue={config?.models?.routine?.defaultModelRef ?? ''}
          automationModelValue={config?.models?.automation?.defaultModelRef ?? ''}
          extractionModelValue={getMemoryExtractionModelRef(config)}
          embeddingModelValue={config?.models?.embedding?.defaultModelRef ?? ''}
          rerankModelValue={memoryRuntimeConfig?.retrieval.rerankModelRef ?? ''}
          imageGenerationValue={config?.models?.imageGeneration ?? {}}
          contextWindows={config?.models?.contextWindows ?? {}}
          contextModelRef={contextModelRef}
          contextWindowInput={contextWindowInput}
          savingAction={savingAction}
          syncingModelMeta={syncingModelMeta}
          thinkingLevel={thinkingLevel}
          onThinkingLevelChange={handleThinkingLevelChange}
          readingSettings={readingSettings}
          onReadingModelChange={(field, modelRef) => void persistReadingModel(field, modelRef)}
          onContextModelRefChange={setContextModelRef}
          onContextWindowInputChange={setContextWindowInput}
          onActionModelChange={(action, modelRef) => void persistActionModel(action, modelRef)}
          onImageGenerationChange={(next) => void persistImageGeneration(next)}
          onAddContextWindow={() => void handleAddContextWindow()}
          onRemoveContextWindow={(modelRef) => void handleRemoveContextWindow(modelRef)}
          onSyncModelMeta={() => void handleSyncModelMeta()}
          />
        </div>
      )}
      <ConnectionSetupSheet
        open={connectionSetupOpen}
        onOpenChange={setConnectionSetupOpen}
        onCreated={(connectionId) => {
          setActiveProvider(connectionId)
          void reload()
        }}
      />
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
    { icon: KeyRound, label: '已连接供应商', value: String(connectedProviderCount), tone: 'bg-[color-mix(in_oklab,var(--brand)_9%,var(--surface-1))] text-[var(--brand)]' },
    { icon: Box, label: '可用模型', value: String(availableModelCount), tone: 'bg-[var(--surface-2)] text-[var(--text-2)]' },
    { icon: UserRound, label: '默认供应商', value: defaultProviderLabel, tone: 'bg-[var(--surface-2)] text-[var(--text-2)]' },
    { icon: Activity, label: '连接状态', value: connectedProviderCount > 0 ? '正常' : '待配置', tone: 'bg-[color-mix(in_oklab,var(--lume-success)_10%,var(--surface-1))] text-[var(--lume-success)]', status: 'success' },
  ]

  return (
    <section className="lume-panel grid h-[76px] grid-cols-4 overflow-hidden">
      {stats.map((stat, index) => {
        const Icon = stat.icon
        return (
          <div key={stat.label} className={cn('flex items-center gap-3 px-5', index > 0 && 'border-l border-[color:color-mix(in_oklab,var(--border)_52%,transparent)]')}>
            <div className={cn('flex size-10 items-center justify-center rounded-[8px]', stat.tone)}>
              <Icon size={18} strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-medium leading-4 text-[var(--text-2)]">{stat.label}</div>
              <div className={cn('mt-1 truncate text-[18px] font-semibold leading-6 text-[var(--text-1)]', stat.status === 'success' && 'text-[var(--lume-success)]')}>
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
  legacyModelRefs?: string[]
  label: string
}

function ModelActionSettings({
  chatOptions,
  embeddingOptions,
  imageOptions,
  rerankOptions,
  backgroundModelValue,
  contextCompressionModelValue,
  titleModelValue,
  welcomeSuggestionsModelValue,
  permissionClassifierModelValue,
  memoryJudgementModelValue,
  subagentModelValue,
  routineModelValue,
  automationModelValue,
  extractionModelValue,
  embeddingModelValue,
  rerankModelValue,
  imageGenerationValue,
  contextWindows,
  contextModelRef,
  contextWindowInput,
  savingAction,
  syncingModelMeta,
  thinkingLevel,
  onThinkingLevelChange,
  readingSettings,
  onReadingModelChange,
  onContextModelRefChange,
  onContextWindowInputChange,
  onActionModelChange,
  onImageGenerationChange,
  onAddContextWindow,
  onRemoveContextWindow,
  onSyncModelMeta,
}: {
  chatOptions: ActionModelOption[]
  embeddingOptions: ActionModelOption[]
  imageOptions: ActionModelOption[]
  rerankOptions: ActionModelOption[]
  backgroundModelValue: string
  contextCompressionModelValue: string
  titleModelValue: string
  welcomeSuggestionsModelValue: string
  permissionClassifierModelValue: string
  memoryJudgementModelValue: string
  subagentModelValue: string
  routineModelValue: string
  automationModelValue: string
  extractionModelValue: string
  embeddingModelValue: string
  rerankModelValue: string
  imageGenerationValue: { priorityModelRefs?: string[] }
  contextWindows: Record<string, number>
  contextModelRef: string
  contextWindowInput: string
  savingAction: string | null
  syncingModelMeta: boolean
  thinkingLevel: LumeConfigThinkingLevel
  onThinkingLevelChange: (value: LumeConfigThinkingLevel) => void
  readingSettings: ReadingSettings | null
  onReadingModelChange: (field: ReadingModelField, modelRef: string) => void
  onContextModelRefChange: (value: string) => void
  onContextWindowInputChange: (value: string) => void
  onActionModelChange: (action: string, modelRef: string) => void
  onImageGenerationChange: (value: { priorityModelRefs?: string[] }) => void
  onAddContextWindow: () => void
  onRemoveContextWindow: (modelRef: string) => void
  onSyncModelMeta: () => void
}) {
  const inheritDefault = '与默认对话模型相同'
  const inheritBackground = '与轻量模型相同'

  return (
    <div className="space-y-4">
      <SettingsCard
        title="主力模型"
        description="核心对话、复杂推理和日程规划使用的模型。"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-5 text-[var(--text-1)]">推理强度</div>
            <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">影响回复前的思考深度</div>
          </div>
          <ThinkingLevelPicker value={thinkingLevel} onChange={onThinkingLevelChange} inline />
        </div>
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
        <ActionModelRow
          title="自动化任务"
          description="自动化页面创建的定时任务使用"
          value={automationModelValue}
          options={chatOptions}
          inheritLabel={inheritDefault}
          disabled={savingAction === 'automation'}
          onChange={(value) => onActionModelChange('automation', value)}
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

      <ReadingModelSettings
        chatOptions={chatOptions}
        imageOptions={imageOptions}
        readingSettings={readingSettings}
        savingAction={savingAction}
        onReadingModelChange={onReadingModelChange}
      />

      <ImageGenerationSettings
        options={imageOptions}
        value={imageGenerationValue}
        disabled={savingAction === 'image-generation'}
        onChange={onImageGenerationChange}
      />

      <ModelInfoSettings
        chatOptions={chatOptions}
        contextWindows={contextWindows}
        modelRef={contextModelRef}
        tokens={contextWindowInput}
        disabled={savingAction === 'context-windows'}
        onModelRefChange={onContextModelRefChange}
        onTokensChange={onContextWindowInputChange}
        onAdd={onAddContextWindow}
        onRemove={onRemoveContextWindow}
        syncing={syncingModelMeta}
        onSync={onSyncModelMeta}
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
  const currentOption = findActionModelOption(options, value)
  const hasCurrentOption = !value || Boolean(currentOption)
  const selectValue = currentOption?.modelRef || value || '__inherit__'

  return (
    <div className="grid min-h-[62px] grid-cols-[minmax(0,1fr)_minmax(220px,340px)] items-center gap-5 border-b border-[color:color-mix(in_oklab,var(--border)_55%,transparent)] py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold leading-5 text-[var(--text-1)]">{title}</div>
        <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">{description}</div>
      </div>
      <Select
        value={selectValue}
        onValueChange={(nextValue) => {
          if (nextValue == null) return
          onChange(nextValue === '__inherit__' ? '' : nextValue)
        }}
        disabled={disabled || (options.length === 0 && !inheritLabel)}
      >
        <SelectTrigger className="h-9 w-full border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-2)] text-[13px] font-medium text-[var(--text-1)] shadow-none focus-visible:ring-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {inheritLabel ? (
            <SelectItem value="__inherit__">{inheritLabel}</SelectItem>
          ) : options.length === 0 ? (
            <SelectItem value="__inherit__">未配置可用模型</SelectItem>
          ) : null}
          {value && !hasCurrentOption && <SelectItem value={value}>{value}</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option.modelRef} value={option.modelRef}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  const selected = new Set(priority.map((modelRef) => findActionModelOption(options, modelRef)?.modelRef ?? modelRef))
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
      ? priority.filter((item) => (findActionModelOption(options, item)?.modelRef ?? item) !== modelRef)
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
          <Button
            variant="ghost"
            type="button"
            disabled={disabled || options.length === 0}
            onClick={() => setOpen((next) => !next)}
            className="mt-1 flex h-10 w-full items-center justify-between rounded-[8px] border border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-2)] px-3 text-left text-[13px] font-medium text-[var(--text-1)] outline-none transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_24%,var(--border))] disabled:opacity-60"
          >
            <span>{priority.length > 0 ? `已选 ${priority.length} 个模型` : '选择模型'}</span>
            <ChevronDown size={16} className={cn('text-[var(--text-3)] transition-transform', open && 'rotate-180')} />
          </Button>
          {open && (
            <div className="absolute left-0 right-0 z-30 mt-2 overflow-hidden rounded-[10px] border border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-1)] shadow-[0_18px_42px_-34px_hsl(var(--lume-shadow-panel)/0.34)]">
              <div className="flex h-10 items-center gap-2 border-b border-[color:color-mix(in_oklab,var(--border)_55%,transparent)] px-3">
                <Search size={15} className="text-[var(--text-3)]" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="过滤模型..."
                  className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
                />
              </div>
              <div className="max-h-[260px] overflow-y-auto">
                {filteredOptions.length === 0 ? (
                  <div className="px-3 py-4 text-[12px] text-[var(--text-3)]">没有匹配的模型</div>
                ) : filteredOptions.map((option) => (
                  <Button
                    variant="ghost"
                    key={option.modelRef}
                    type="button"
                    onClick={() => toggleModel(option.modelRef)}
                    className="grid h-auto min-h-12 w-full grid-cols-[26px_minmax(0,1fr)] items-center justify-start gap-2 border-b border-[color:color-mix(in_oklab,var(--border)_55%,transparent)] px-3 text-left whitespace-normal last:border-b-0 hover:bg-[var(--surface-2)]"
                  >
                    <span className={cn(
                      'flex size-5 items-center justify-center rounded-[5px] border text-[var(--brand-foreground)]',
                      selected.has(option.modelRef)
                        ? 'border-[var(--brand)] bg-[var(--brand)]'
                        : 'border-[var(--border-strong)] bg-transparent'
                    )}>
                      {selected.has(option.modelRef) && <Check size={14} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-[var(--text-1)]">{option.label}</span>
                      <span className="block truncate text-[12px] text-[var(--text-3)]">{option.modelRef}</span>
                    </span>
                  </Button>
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
                'grid min-h-10 grid-cols-[24px_28px_minmax(0,1fr)_32px] items-center gap-2 rounded-[8px] bg-[var(--surface-2)] px-3',
                draggingRef === modelRef && 'opacity-50'
              )}
            >
              <GripVertical size={15} className="cursor-grab text-[var(--text-3)]" />
              <span className="text-center text-[12px] font-semibold text-[var(--text-3)]">{index + 1}</span>
              <span className="truncate text-[13px] font-medium text-[var(--text-1)]">{getOptionLabel(options, modelRef)}</span>
              <Button
                variant="ghost"
                type="button"
                disabled={disabled}
                onClick={() => toggleModel(modelRef)}
                className="flex size-7 items-center justify-center rounded-[6px] text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--lume-danger)] disabled:opacity-40"
              >
                <X size={14} />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </SettingsCard>
  )
}

function ModelInfoSettings({
  chatOptions,
  contextWindows,
  modelRef,
  tokens,
  disabled,
  syncing,
  onModelRefChange,
  onTokensChange,
  onAdd,
  onRemove,
  onSync,
}: {
  chatOptions: ActionModelOption[]
  contextWindows: Record<string, number>
  modelRef: string
  tokens: string
  disabled?: boolean
  syncing: boolean
  onModelRefChange: (value: string) => void
  onTokensChange: (value: string) => void
  onAdd: () => void
  onRemove: (modelRef: string) => void
  onSync: () => void
}) {
  const modelMetaVersion = useModelMetaVersion()
  // model 元数据 reload 后触发组件重渲染。
  void modelMetaVersion
  const rows = buildModelInfoRows(chatOptions, contextWindows)

  return (
    <SettingsCard
      title="模型信息维护"
      description="维护已启用模型的能力、上下文长度和价格信息。"
      action={(
        <Button
          type="button"
          variant="outline"
          disabled={syncing}
          onClick={onSync}
          className="h-8 gap-1.5 rounded-[8px] px-3 text-[12px]"
        >
          <RefreshCw size={13} className={cn(syncing && 'animate-spin')} />
          {syncing ? '更新中…' : '更新 models.dev'}
        </Button>
      )}
    >
      <div className="space-y-3">
        <div className="overflow-x-auto rounded-[8px] bg-[var(--surface-2)]">
          <div className="grid min-w-[620px] grid-cols-[minmax(0,1.4fr)_76px_minmax(130px,1fr)_110px] gap-3 border-b border-[color:color-mix(in_oklab,var(--border)_55%,transparent)] px-3 py-2 text-[10px] font-medium text-[var(--text-3)]">
            <span>模型</span>
            <span className="text-right">上下文</span>
            <span>能力</span>
            <span className="text-right">价格 / 1M</span>
          </div>
          <div className="max-h-[410px] overflow-y-auto">
          {rows.map((row) => (
            <div key={row.modelRef} className="grid min-h-14 min-w-[620px] grid-cols-[minmax(0,1.4fr)_76px_minmax(130px,1fr)_110px] items-center gap-3 border-b border-[color:color-mix(in_oklab,var(--border)_55%,transparent)] px-3 py-2 last:border-b-0">
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold text-[var(--text-1)]">{row.modelRef}</div>
                <div className="truncate text-[11px] text-[var(--text-3)]">{row.label}</div>
              </div>
              <span className="justify-self-end rounded-[7px] bg-[var(--surface-1)] px-2 py-1 text-[12px] font-semibold text-[var(--text-2)]">
                {row.contextWindow ? formatContextWindow(row.contextWindow) : '未收录'}
              </span>
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                {row.meta ? <ModelCapabilityBadges meta={row.meta} /> : <span className="text-[11px] text-[var(--text-3)]">暂无能力信息</span>}
              </div>
              <div className="flex items-center justify-end gap-2">
                {row.meta?.pricing && <span className="text-[10px] text-[var(--text-3)]">{formatPricing(row.meta.pricing)}</span>}
                {row.custom ? (
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={disabled}
                    onClick={() => onRemove(row.modelRef)}
                    className="h-7 px-1.5 text-[11px] font-medium text-[var(--lume-danger)] disabled:opacity-40"
                  >
                    移除覆盖
                  </Button>
                ) : (
                  <span className="text-[10px] text-[var(--text-3)]">默认</span>
                )}
              </div>
            </div>
          ))}
          </div>
        </div>

        <div className="rounded-[8px] bg-[var(--surface-2)] p-3">
          <div className="mb-2 text-[12px] font-semibold text-[var(--text-1)]">手动覆盖上下文长度</div>
          <div className="grid grid-cols-[minmax(0,1fr)_150px_72px] gap-2">
            <Input
              value={modelRef}
              onChange={(event) => onModelRefChange(event.target.value)}
              placeholder="模型名（如 zai/glm-5.2）"
              className="h-9 rounded-[8px] border border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[color:color-mix(in_oklab,var(--brand)_42%,var(--border-strong))]"
            />
            <Input
              value={tokens}
              onChange={(event) => onTokensChange(event.target.value)}
              placeholder="1000000"
              inputMode="numeric"
              className="h-9 rounded-[8px] border border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[color:color-mix(in_oklab,var(--brand)_42%,var(--border-strong))]"
            />
            <Button type="button" disabled={disabled} onClick={onAdd} className="h-9 rounded-[8px] text-[13px]">添加</Button>
          </div>
        </div>
      </div>
    </SettingsCard>
  )
}

function ModelCatalogPanel({
  channels,
  onToggleModel,
}: {
  channels: Channel[]
  onToggleModel: (connectionId: string, modelId: string, enabled: boolean) => Promise<void>
}) {
  const [query, setQuery] = React.useState('')
  const [savingId, setSavingId] = React.useState<string | null>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const rows = channels.flatMap((channel) => channel.models.map((model) => ({ channel, model })))
    .filter(({ channel, model }) => !normalizedQuery
      || model.id.toLowerCase().includes(normalizedQuery)
      || model.name.toLowerCase().includes(normalizedQuery)
      || channel.name.toLowerCase().includes(normalizedQuery))

  return (
    <SettingsCard
      title="模型目录"
      description="模型以连接和模型 ID 共同标识；同步发现的新模型会直接启用，手工模型不会被同步删除。"
    >
      <div className="space-y-3">
        <div className="relative max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模型或连接"
            className="pl-9"
          />
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">没有匹配的模型</p>
          ) : rows.map(({ channel, model }) => {
            const rowId = `${channel.id}:${model.id}`
            const capabilities = Object.entries(model.capabilities ?? {})
              .filter(([, enabled]) => enabled)
              .map(([name]) => name)
            return (
              <div key={rowId} className="grid grid-cols-[minmax(0,1fr)_minmax(140px,0.45fr)_auto] items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{model.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{model.id}</div>
                </div>
                <div className="min-w-0">
                  <div className="truncate text-xs text-foreground/80">{channel.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {model.source === 'discovered' ? '已同步' : '手工'}
                    </span>
                    {capabilities.map((capability) => (
                      <span key={capability} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {capability}
                      </span>
                    ))}
                  </div>
                </div>
                <Switch
                  checked={model.enabled}
                  disabled={savingId === rowId}
                  aria-label={`${model.enabled ? '停用' : '启用'} ${model.name}`}
                  onCheckedChange={(enabled) => {
                    setSavingId(rowId)
                    void onToggleModel(channel.id, model.id, enabled)
                      .catch((error) => {
                        console.error('[ModelCatalogPanel] toggle model FAILED:', error)
                        toast.error('更新模型状态失败')
                      })
                      .finally(() => setSavingId(null))
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>
    </SettingsCard>
  )
}

const READING_STAGE_DESCRIPTIONS: Record<keyof ReadingAdvancedModelSettings, string> = {
  selectionModelRef: '从书架挑选下一本要读的书',
  seedModelRef: '生成札记的种子草稿',
  deepModelRef: '产出深度读书笔记',
  companionModelRef: '陪读聊天与答疑',
}

function ReadingModelSettings({
  chatOptions,
  imageOptions,
  readingSettings,
  savingAction,
  onReadingModelChange,
}: {
  chatOptions: ActionModelOption[]
  imageOptions: ActionModelOption[]
  readingSettings: ReadingSettings | null
  savingAction: string | null
  onReadingModelChange: (field: ReadingModelField, modelRef: string) => void
}) {
  if (!readingSettings) return null
  const textValue = readingSettings.textModelMode === 'inherit' ? '' : (readingSettings.textModelRef ?? '')
  return (
    <SettingsCard
      title="读书模型"
      description="阅读流程各阶段使用的模型，留空表示继承上一级。"
    >
      <ActionModelRow
        title="文本模型"
        description="选书、札记、深度笔记等通用文本任务"
        value={textValue}
        options={chatOptions}
        inheritLabel="继承默认对话模型"
        disabled={savingAction === 'reading-text'}
        onChange={(ref) => onReadingModelChange('text', ref)}
      />
      <ActionModelRow
        title="图像模型"
        description="读书卡片封面与配图生成"
        value={readingSettings.imageModelRef ?? ''}
        options={imageOptions}
        inheritLabel="未指定（不生成图像）"
        disabled={savingAction === 'reading-image'}
        onChange={(ref) => onReadingModelChange('image', ref)}
      />
      {READING_ADVANCED_STAGE_OPTIONS.map((stage) => (
        <ActionModelRow
          key={stage.id}
          title={stage.label}
          description={READING_STAGE_DESCRIPTIONS[stage.id]}
          value={readingSettings.advanced[stage.id] ?? ''}
          options={chatOptions}
          inheritLabel="继承文本模型"
          disabled={savingAction === `reading-${stage.id}`}
          onChange={(ref) => onReadingModelChange(stage.id, ref)}
        />
      ))}
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
  providerSearch,
  savingProvider,
  onActiveProviderChange,
  onActiveGroupChange,
  onToggleChannelEnabled,
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
  providerSearch: string
  savingProvider: boolean
  onActiveProviderChange: (id: string) => void
  onActiveGroupChange: (group: ProviderGroup) => void
  onToggleChannelEnabled: (channelId: string, checked: boolean) => void
  onProviderSearchChange: (value: string) => void
  onProviderSubmit: (input: ChannelCreateInput) => Promise<void>
  onReload: () => void
}) {
  const activeChannel = activeProviderRow?.channel ?? null
  const activeLabel = activeProviderRow?.label ?? '尚未添加连接'

  const handleDelete = () => {
    if (!activeChannel) return
    if (!confirm(`确定直接删除“${activeLabel}”？引用该连接的模型用途会显示为不可用，凭据也会一并移除。`)) return
    deleteChannel(activeChannel.id)
      .then(() => {
        toast.success('连接已删除')
        onReload()
      })
      .catch((error) => {
        console.error('[AgentSettings] delete connection FAILED:', error)
        toast.error('删除连接失败')
      })
  }

  return (
    <div className="lume-subpanel overflow-hidden rounded-[9px] p-3">
      {/* 分组标签栏 */}
      <div className="flex flex-wrap gap-1">
        {PROVIDER_GROUPS.map((group) => (
          <Button
            variant="ghost"
            key={group.key}
            type="button"
            onClick={() => onActiveGroupChange(group.key)}
            className={cn(
              'rounded-[5px] px-2 py-1 text-[11px] font-medium transition-colors',
              activeGroup === group.key
                ? 'bg-[color-mix(in_oklab,var(--brand)_9%,var(--surface-1))] text-[var(--brand)]'
                : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]'
            )}
          >
            {group.label}
          </Button>
        ))}
      </div>

      {/* 搜索 */}
      <div className="relative mt-2">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
        <Input
          value={providerSearch}
          onChange={(event) => onProviderSearchChange(event.target.value)}
          placeholder="搜索供应商"
          className="h-8 w-full rounded-[7px] border border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-1)] pl-9 pr-3 text-[12px] font-medium text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[color:color-mix(in_oklab,var(--brand)_42%,var(--border-strong))]"
        />
      </div>

      {/* 手风琴列表：单列，展开即编辑 */}
      <div className="mt-2 space-y-1.5">
        {filteredProviderRows.map((row) => {
          const rowKey = row.channelId ?? row.provider
          const channelId = row.channel?.id
          const isExpanded = activeProvider === rowKey
          return (
            <ProviderListItem
              key={rowKey}
              row={row}
              expanded={isExpanded}
              onClick={() => onActiveProviderChange(isExpanded ? '' : rowKey)}
              onToggleEnabled={channelId ? (checked) => onToggleChannelEnabled(channelId, checked) : undefined}
            >
              {isExpanded && (
                <div className="border-t border-[color:color-mix(in_oklab,var(--border)_55%,transparent)] bg-[var(--surface-1)] p-4">
                  {apiKeyLoading ? (
                    <div className="flex h-[290px] items-center gap-2 rounded-[9px] bg-[var(--surface-2)] px-4 text-[13px] text-[var(--text-3)]">
                      <Loader2 size={14} className="animate-spin" />
                      加载供应商详情...
                    </div>
                  ) : (
                    <ChannelForm
                      key={activeProviderRow?.channelId ?? activeProvider}
                      mode={activeChannel ? 'edit' : 'create'}
                      initialValue={initialValue}
                      providerLocked={activeGroup !== 'custom'}
                      disabled={savingProvider}
                      connectionId={activeChannel?.id}
                      onSubmit={onProviderSubmit}
                      onSynced={onReload}
                      onDelete={handleDelete}
                    />
                  )}
                </div>
              )}
            </ProviderListItem>
          )
        })}
        {filteredProviderRows.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的已配置连接</p>
        )}
      </div>
    </div>
  )
}

function ProviderListItem({
  row,
  expanded,
  onClick,
  onToggleEnabled,
  children,
}: {
  row: ModelProviderRow
  expanded: boolean
  onClick: () => void
  onToggleEnabled?: (checked: boolean) => void
  children?: React.ReactNode
}) {
  const configured = Boolean(row.channel)
  const connected = row.channel ? isConnectionReady(row.channel) : false
  const needsAuthentication = Boolean(row.channel?.enabled && !connected)
  const unavailable = row.channel?.healthStatus === 'unavailable'
  const available = row.channel?.healthStatus === 'available'

  return (
    <div
      className={cn(
        'overflow-hidden rounded-[7px] border transition-colors',
        expanded
          ? 'border-[color:color-mix(in_oklab,var(--brand)_42%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_9%,var(--surface-1))]'
          : 'border-transparent'
      )}
    >
      <Button
        variant="ghost"
        type="button"
        onClick={onClick}
        className={cn(
          'flex h-12 w-full items-center gap-2.5 rounded-[7px] px-4 text-left transition-colors',
          expanded
            ? 'text-[var(--brand)]'
            : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]'
        )}
      >
        <span className={cn('flex size-7 items-center justify-center rounded-[6px]', row.tone)}>
          <ChannelProviderIcon provider={row.provider} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-5">{row.label}</span>
          <span className="block truncate text-[11px] leading-4 text-[var(--text-3)]">
            {row.channel ? `${row.channel.models?.length ?? 0} 模型` : '未配置'}
          </span>
        </span>
        <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--text-2)]">
          <span className={cn(
            'size-1.5 rounded-full',
            unavailable
              ? 'bg-destructive'
              : available || connected
                ? 'bg-[var(--lume-success)]'
                : configured ? 'bg-[var(--text-3)]' : 'bg-[var(--border-strong)]'
          )} />
          {unavailable
            ? '不可用'
            : available
              ? '可用'
              : needsAuthentication
                ? '待认证'
                : connected
                  ? '已连接'
                  : configured ? '已配置' : '未配置'}
        </span>
        {configured && onToggleEnabled && (
          <LumeSwitch
            checked={Boolean(row.channel?.enabled)}
            onCheckedChange={onToggleEnabled}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label={row.channel?.enabled ? `停用 ${row.label}` : `启用 ${row.label}`}
          />
        )}
        <ChevronDown
          size={15}
          className={cn(
            'shrink-0 text-[var(--text-3)] transition-transform duration-200',
            expanded && 'rotate-180'
          )}
        />
      </Button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
    <section className="lume-panel px-4 py-3">
      {(title || action) && (
        <div className="mb-3 flex min-h-8 items-start justify-between gap-4 border-b border-[color:color-mix(in_oklab,var(--border)_48%,transparent)] pb-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold leading-5 text-[var(--text-1)]">{title}</h2>}
            {description && <p className="mt-1 text-[12px] leading-4 text-[var(--text-3)]">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

function LumeSwitch(props: React.ComponentProps<typeof Switch>) {
  return (
    <Switch
      {...props}
      className={cn(
        'data-[size=default]:h-[18px] data-[size=default]:w-[32px] data-checked:bg-[var(--brand)] data-unchecked:bg-[var(--surface-3)]',
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
  return findActionModelOption(options, modelRef)?.label ?? modelRef
}

function findActionModelOption(options: ActionModelOption[], modelRef: string): ActionModelOption | undefined {
  const exact = options.find((option) => option.modelRef === modelRef)
  if (exact) return exact
  const legacyMatches = options.filter((option) => option.legacyModelRefs?.includes(modelRef) === true)
  return legacyMatches.length === 1 ? legacyMatches[0] : undefined
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length) return items
  const next = [...items]
  const [item] = next.splice(from, 1)
  if (item === undefined) return items
  next.splice(to, 0, item)
  return next
}

const MODEL_CAPABILITY_BADGES = [
  { key: 'vision', label: '视觉', icon: Eye },
  { key: 'toolUse', label: '工具', icon: Wrench },
  { key: 'reasoning', label: '推理', icon: Brain },
] as const

function ModelCapabilityBadges({ meta }: { meta: ModelMeta }) {
  const badges = MODEL_CAPABILITY_BADGES.filter(({ key }) => meta.capabilities[key])
  if (badges.length === 0) return <span className="text-[11px] text-[var(--text-3)]">基础对话</span>

  return badges.map(({ key, label, icon: Icon }) => (
    <span key={key} className="inline-flex items-center gap-1 rounded-[5px] bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-2)]">
      <Icon size={11} />
      {label}
    </span>
  ))
}

function buildModelInfoRows(
  options: ActionModelOption[],
  overrides: Record<string, number>
): Array<{ modelRef: string; label: string; contextWindow?: number; custom: boolean; meta?: ModelMeta }> {
  const rows = new Map<string, { modelRef: string; label: string; contextWindow?: number; custom: boolean; meta?: ModelMeta }>()
  for (const option of options) {
    const meta = findModelMeta(option.modelRef)
    rows.set(option.modelRef, {
      modelRef: option.modelRef,
      label: option.label,
      contextWindow: overrides[option.modelRef] ?? meta?.contextWindow,
      custom: overrides[option.modelRef] !== undefined,
      meta,
    })
  }
  for (const [modelRef, contextWindow] of Object.entries(overrides)) {
    if (rows.has(modelRef)) continue
    rows.set(modelRef, {
      modelRef,
      label: modelRef,
      contextWindow,
      custom: true,
      meta: findModelMeta(modelRef),
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
    ? findModelOption(input.options, configuredModelRef, input.strategy?.defaultChannelId)
      ?? findModelOption(input.options, configuredModelRef)
      ?? fallbackOption
    : fallbackOption
  const channel = option
    ? input.channels.find((item) => item.id === option.channelId) ?? null
    : null

  return { option, channel }
}
