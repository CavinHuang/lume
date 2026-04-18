import type { AgentThreadMeta, Channel, ChannelModel, LumeConfigAgentDefaultStrategy, ModelCapabilities, ModelMeta } from '@lume/shared'
import { findModelMeta, inferCapabilities } from '@lume/shared'

export interface ModelSelectionOption {
  channelId: string
  modelRef: string
  modelId: string
  label: string
  active: boolean
  meta?: ModelMeta
  /** Inferred capabilities when no registry match exists */
  inferredCapabilities?: ModelCapabilities
}

export interface ModelOptionGroup {
  id: string
  label: string
  provider: string
  options: ModelSelectionOption[]
}

export interface ThreadSelectionSummary {
  label: string
  hasLoadedChannels: boolean
  isOverride: boolean
  isUnavailable: boolean
  meta?: ModelMeta
}

function normalizeOptional(value?: string | null): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function isCanonicalModelRef(modelId: string): boolean {
  const trimmed = modelId.trim()
  if (!trimmed) {
    return false
  }

  const slashIndex = trimmed.indexOf('/')
  return slashIndex > 0 && slashIndex < trimmed.length - 1
}

function buildModelRef(channel: Pick<Channel, 'provider'>, modelId: string): string {
  return isCanonicalModelRef(modelId)
    ? modelId
    : `${channel.provider}/${modelId}`
}

function getModelRefVariants(channel: Pick<Channel, 'id' | 'provider'>, model: Pick<ChannelModel, 'id'>): string[] {
  const providerModelRef = buildModelRef(channel, model.id)
  const channelScopedModelRef = `${channel.id}/${model.id}`

  return [
    model.id,
    providerModelRef,
    ...(channelScopedModelRef ? [channelScopedModelRef] : []),
  ]
}

function matchesSelection(input: {
  channel: Pick<Channel, 'id' | 'provider'>
  model: Pick<ChannelModel, 'id'>
  activeChannelId?: string
  activeModelRef?: string
}): boolean {
  const activeChannelId = normalizeOptional(input.activeChannelId)
  const activeModelRef = normalizeOptional(input.activeModelRef)

  if (!activeChannelId || !activeModelRef) {
    return false
  }

  if (input.channel.id !== activeChannelId) {
    return false
  }

  return getModelRefVariants(input.channel, input.model).includes(activeModelRef)
}

function findSelectionMatch(input: {
  channels: Channel[]
  channelId?: string
  modelRef?: string
}): { channel: Channel; model: ChannelModel } | null {
  const channelId = normalizeOptional(input.channelId)
  const modelRef = normalizeOptional(input.modelRef)

  if (!channelId || !modelRef) {
    return null
  }

  const channel = input.channels.find((item) => item.id === channelId)
  if (!channel) {
    return null
  }

  const model = channel.models.find((item) => getModelRefVariants(channel, item).includes(modelRef))
  if (!model) {
    return null
  }

  return { channel, model }
}

export function buildModelSelectionGroups(input: {
  channels: Channel[]
  activeChannelId?: string
  activeModelRef?: string
}): ModelOptionGroup[] {
  return input.channels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      id: channel.id,
      label: channel.name,
      provider: channel.provider,
      options: channel.models
        .filter((model) => model.enabled)
        .map((model) => {
          const meta = findModelMeta(model.id) ?? findModelMeta(model.name)
          const inferredCapabilities = !meta ? inferCapabilities(model.id, model.name) : undefined
          return {
            channelId: channel.id,
            modelId: model.id,
            modelRef: buildModelRef(channel, model.id),
            label: model.name,
            active: matchesSelection({
              channel,
              model,
              activeChannelId: input.activeChannelId,
              activeModelRef: input.activeModelRef,
            }),
            meta,
            inferredCapabilities,
          }
        }),
    }))
    .filter((group) => group.options.length > 0)
}

export function getThreadSelectionSummary(input: {
  channels: Channel[]
  channelsLoaded?: boolean
  thread?: Pick<AgentThreadMeta, 'channelId' | 'modelRef' | 'modelSelectionSource'> | null
  defaultStrategy?: LumeConfigAgentDefaultStrategy
}): ThreadSelectionSummary {
  const hasLoadedChannels = input.channelsLoaded ?? false

  // 线程覆盖优先，否则回退到全局默认策略
  const channelId = normalizeOptional(input.thread?.channelId) ?? normalizeOptional(input.defaultStrategy?.defaultChannelId)
  const modelRef = normalizeOptional(input.thread?.modelRef) ?? normalizeOptional(input.defaultStrategy?.defaultModelRef)

  const match = findSelectionMatch({
    channels: input.channels,
    channelId,
    modelRef,
  })

  if (match) {
    const meta = findModelMeta(match.model.id) ?? findModelMeta(match.model.name)
    return {
      label: match.model.name,
      hasLoadedChannels,
      isOverride: input.thread?.modelSelectionSource === 'thread-override',
      isUnavailable: !match.channel.enabled || !match.model.enabled,
      meta,
    }
  }

  return {
    label: modelRef ?? '',
    hasLoadedChannels,
    isOverride: input.thread?.modelSelectionSource === 'thread-override',
    isUnavailable: hasLoadedChannels && Boolean(modelRef),
  }
}
