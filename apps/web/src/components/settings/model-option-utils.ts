import type { Channel } from '@lume/shared'

export interface ModelOption {
  channelId: string
  provider: string
  modelId: string
  modelRef: string
  label: string
  channelLabel: string
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

export function getModelLabel(modelOptions: ModelOption[], modelRef?: string): string {
  const normalized = modelRef?.trim()
  if (!normalized) {
    return '未设置'
  }

  return modelOptions.find((option) => option.modelRef === normalized)?.label ?? normalized
}
