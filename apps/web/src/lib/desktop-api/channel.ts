import { invoke } from '@/lib/desktop-runtime/core'
import { sidecarCall } from './system'
import type { Channel, ChannelCreateInput, ChannelTestResult, ChannelUpdateInput, ConnectionOAuthSessionStatus, FetchModelsInput, FetchModelsResult, SyncChannelModelsResult } from '@lume/shared'

export const listChannels = () =>
  sidecarCall<Channel[]>('channel:list', {})

export const createChannel = (input: ChannelCreateInput) =>
  sidecarCall<Channel>('channel:create', input)

export const updateChannel = (id: string, input: ChannelUpdateInput) =>
  sidecarCall<Channel>('channel:update', { id, input })

export const deleteChannel = (id: string) =>
  sidecarCall<void>('channel:delete', { id })

export const testChannelConnection = (channelId: string) =>
  sidecarCall<ChannelTestResult>('channel:test', { channelId })

export const getConnectionVaultStatus = () =>
  invoke<{ configured: boolean; secureStorageAvailable: boolean; unlocked: boolean }>('connection_vault_status', {})

export const setupConnectionVault = (password: string) =>
  invoke<{ configured: boolean; secureStorageAvailable: boolean; unlocked: boolean }>('connection_vault_setup', { password })

export const unlockConnectionVault = (password: string) =>
  invoke<{ configured: boolean; secureStorageAvailable: boolean; unlocked: boolean }>('connection_vault_unlock', { password })

export const verifyConnectionVaultPassword = (password: string) =>
  invoke<{ valid: boolean }>('connection_vault_verify', { password })

export const decryptChannelKey = (id: string, password: string) =>
  invoke<{ apiKey: string }>('connection_vault_reveal_key', { channelId: id, password })
    .then((result) => result.apiKey)

export const fetchChannelModels = (input: FetchModelsInput) =>
  sidecarCall<FetchModelsResult>('channel:fetch-models', input)

export const syncChannelModels = (channelId: string) =>
  sidecarCall<SyncChannelModelsResult>('channel:sync-models', { channelId })

export const startConnectionOAuthLogin = (connectionId: string) =>
  sidecarCall<ConnectionOAuthSessionStatus>('channel:oauth-start', { connectionId })

export const getConnectionOAuthLoginStatus = (sessionId: string) =>
  sidecarCall<ConnectionOAuthSessionStatus>('channel:oauth-status', { sessionId })

export const answerConnectionOAuthPrompt = (sessionId: string, promptId: string, value: string) =>
  sidecarCall<ConnectionOAuthSessionStatus>('channel:oauth-answer', { sessionId, promptId, value })

export const cancelConnectionOAuthLogin = (sessionId: string) =>
  sidecarCall<{ ok: true }>('channel:oauth-cancel', { sessionId })
