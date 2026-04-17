import { sidecarCall } from './system'
import type { Channel, ChannelCreateInput, ChannelUpdateInput, FetchModelsResult } from '@lume/shared'

export const listChannels = () =>
  sidecarCall<Channel[]>('channel:list', {})

export const createChannel = (input: ChannelCreateInput) =>
  sidecarCall<Channel>('channel:create', input)

export const updateChannel = (id: string, input: ChannelUpdateInput) =>
  sidecarCall<Channel>('channel:update', { id, input })

export const deleteChannel = (id: string) =>
  sidecarCall<void>('channel:delete', { id })

export const decryptChannelKey = (id: string) =>
  sidecarCall<string>('channel:decrypt-key', { channelId: id })

export const fetchChannelModels = (input: { provider: string; baseUrl: string; apiKey: string }) =>
  sidecarCall<FetchModelsResult>('channel:fetch-models', input)
