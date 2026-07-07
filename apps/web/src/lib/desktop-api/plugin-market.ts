import {
  AGENT_IPC_CHANNELS,
  type GetMarketCatalogInput,
  type GetMarketCatalogResult,
  type GetMarketDetailInput,
  type GetMarketDetailResult,
  type InspectMarketSourceInput,
  type InspectMarketSourceResult,
  type InstallMarketItemInput,
  type InstallMarketItemResult,
  type SetPluginActiveVersionInput,
  type SetPluginActiveVersionResult,
  type SetPluginEnablementInput,
  type SetPluginEnablementResult,
  type UninstallPluginInput,
  type UninstallPluginResult,
  type UpdatePluginInput,
  type UpdatePluginResult,
  type ExportPluginArtifactInput,
  type ExportPluginArtifactResult,
  type DownloadBridgeAssetInput,
  type DownloadBridgeAssetResult,
  type CheckBridgeStatusInput,
  type CheckBridgeStatusResult,
} from '@lume/shared'
import { sidecarCall } from './system'

export const getMarketCatalog = (input: GetMarketCatalogInput) =>
  sidecarCall<GetMarketCatalogResult>(AGENT_IPC_CHANNELS.GET_MARKET_CATALOG, input)

export const getMarketDetail = (input: GetMarketDetailInput) =>
  sidecarCall<GetMarketDetailResult>(AGENT_IPC_CHANNELS.GET_MARKET_DETAIL, input)

export const inspectMarketSource = (input: InspectMarketSourceInput) =>
  sidecarCall<InspectMarketSourceResult>(AGENT_IPC_CHANNELS.INSPECT_MARKET_SOURCE, input)

export const installMarketItem = (input: InstallMarketItemInput) =>
  sidecarCall<InstallMarketItemResult>(AGENT_IPC_CHANNELS.INSTALL_MARKET_ITEM, input)

export const updatePlugin = (input: UpdatePluginInput) =>
  sidecarCall<UpdatePluginResult>(AGENT_IPC_CHANNELS.UPDATE_PLUGIN, input)

export const uninstallPlugin = (input: UninstallPluginInput) =>
  sidecarCall<UninstallPluginResult>(AGENT_IPC_CHANNELS.UNINSTALL_PLUGIN, input)

export const setPluginEnablement = (input: SetPluginEnablementInput) =>
  sidecarCall<SetPluginEnablementResult>(AGENT_IPC_CHANNELS.SET_PLUGIN_ENABLEMENT, input)

export const setPluginActiveVersion = (input: SetPluginActiveVersionInput) =>
  sidecarCall<SetPluginActiveVersionResult>(AGENT_IPC_CHANNELS.SET_PLUGIN_ACTIVE_VERSION, input)

export const exportPluginArtifact = (input: ExportPluginArtifactInput) =>
  sidecarCall<ExportPluginArtifactResult>(AGENT_IPC_CHANNELS.EXPORT_PLUGIN_ARTIFACT, input)

export const downloadBridgeAsset = (input: DownloadBridgeAssetInput) =>
  sidecarCall<DownloadBridgeAssetResult>(AGENT_IPC_CHANNELS.DOWNLOAD_BRIDGE_ASSET, input)

export const checkBridgeStatus = (input: CheckBridgeStatusInput) =>
  sidecarCall<CheckBridgeStatusResult>(AGENT_IPC_CHANNELS.CHECK_BRIDGE_STATUS, input)
