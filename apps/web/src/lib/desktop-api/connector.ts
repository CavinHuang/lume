import { CONNECTOR_IPC_CHANNELS } from '@lume/shared'
import type { ConnectorSetupWithStatus, ConnectorStatus } from '@lume/shared'
import { sidecarCall } from './system'

export const getConnectorSetups = () =>
  sidecarCall<ConnectorSetupWithStatus[]>(CONNECTOR_IPC_CHANNELS.GET_SETUP, {})

export const getConnectorStatus = (service: string) =>
  sidecarCall<ConnectorStatus>(CONNECTOR_IPC_CHANNELS.GET_STATUS, { service })

export const saveConnectorClientConfig = (input: { service: string; clientId: string; clientSecret: string }) =>
  sidecarCall<ConnectorStatus>(CONNECTOR_IPC_CHANNELS.SAVE_CLIENT_CONFIG, input)

export const saveConnectorCredential = (input: { service: string; values: Record<string, string> }) =>
  sidecarCall<ConnectorStatus>(CONNECTOR_IPC_CHANNELS.SAVE_CREDENTIAL, input)

export const startConnectorAuth = (service: string) =>
  sidecarCall<{ authorizationUrl: string; status: ConnectorStatus }>(CONNECTOR_IPC_CHANNELS.START_AUTH, { service })

export const disconnectConnector = (service: string) =>
  sidecarCall<ConnectorStatus>(CONNECTOR_IPC_CHANNELS.DISCONNECT, { service })
