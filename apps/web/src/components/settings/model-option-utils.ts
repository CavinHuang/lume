import { buildConnectionModelRef, isChannelViewReady, type Channel } from '@lume/shared'

export interface ModelOption {
  channelId: string
  provider: string
  modelId: string
  modelRef: string
  legacyModelRefs?: string[]
  label: string
  channelLabel: string
}

function isChatModel(model: Channel['models'][number]): boolean {
  if (!model.enabled) {
    return false
  }
  return model.capabilities?.chat !== false
}

export function isConnectionReady(channel: Channel): boolean {
  return isChannelViewReady(channel)
}

export function getEnabledChannels(channels: Channel[]): Channel[] {
  return channels.filter((channel) => isConnectionReady(channel) && channel.models.some(isChatModel))
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
        modelRef: buildConnectionModelRef(channel.id, model.id),
        legacyModelRefs: [
          model.id,
          `${channel.providerId || channel.provider}/${model.id}`,
          `${channel.id}/${model.id}`,
        ],
        label: model.name,
        channelLabel: channel.name,
      }))
  ))
}

export function findModelOption(
  options: ModelOption[],
  modelRef?: string,
  channelId?: string,
): ModelOption | undefined {
  const normalized = modelRef?.trim()
  if (!normalized) return undefined
  const scoped = channelId?.trim()
  const exact = options.find((option) => (
    option.modelRef === normalized && (!scoped || option.channelId === scoped)
  ))
  if (exact) return exact
  const legacy = options.filter((option) => (
    option.legacyModelRefs?.includes(normalized) === true && (!scoped || option.channelId === scoped)
  ))
  return legacy.length === 1 ? legacy[0] : undefined
}

export function getModelLabel(modelOptions: ModelOption[], modelRef?: string): string {
  const normalized = modelRef?.trim()
  if (!normalized) {
    return '未设置'
  }

  return findModelOption(modelOptions, normalized)?.label ?? normalized
}
