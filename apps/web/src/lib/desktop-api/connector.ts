import { CONNECTOR_IPC_CHANNELS } from '@lume/shared'
import type { ConnectorStatus } from '@lume/shared'
import { sidecarCall } from './system'

export const getConnectorStatus = (service: string) =>
  sidecarCall<ConnectorStatus>(CONNECTOR_IPC_CHANNELS.GET_STATUS, { service })

export const saveConnectorClientConfig = (input: { clientId: string; clientSecret: string }) =>
  sidecarCall<ConnectorStatus>(CONNECTOR_IPC_CHANNELS.SAVE_CLIENT_CONFIG, input)

export const startConnectorAuth = (service: string) =>
  sidecarCall<{ authorizationUrl: string; status: ConnectorStatus }>(CONNECTOR_IPC_CHANNELS.START_AUTH, { service })

export const disconnectConnector = (service: string) =>
  sidecarCall<ConnectorStatus>(CONNECTOR_IPC_CHANNELS.DISCONNECT, { service })
