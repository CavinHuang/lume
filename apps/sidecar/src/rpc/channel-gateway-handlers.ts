import { CHANNEL_GATEWAY_IPC_CHANNELS } from "@lume/shared";
import type {
  ChannelGatewayIngressInput,
  ChannelGatewayListDeliveriesInput,
  ChannelProvider
} from "@lume/shared";
import {
  listChannelGatewayBindings,
  listChannelGatewayDeliveries,
  simulateChannelGatewayIngress,
  upsertChannelGatewayBinding
} from "../services/channel-gateway/gateway-service";
import { testFeishuGatewayConnection } from "../services/channel-gateway/feishu-api";
import {
  getFeishuGatewayConfig,
  getFeishuGatewayConfigView,
  saveFeishuGatewayConfig
} from "../services/channel-gateway/feishu-config-manager";
import {
  getFeishuIngressStatus,
  startFeishuIngressServer,
  stopFeishuIngressServer
} from "../services/channel-gateway/feishu-ingress-service";
import {
  getFeishuWsIngressStatus,
  startFeishuWsIngressServer,
  stopFeishuWsIngressServer
} from "../services/channel-gateway/feishu-ws-ingress-service";
import {
  channelGatewayIngressInputSchema,
  channelGatewayListDeliveriesInputSchema,
  channelGatewayUpsertBindingInputSchema,
  feishuGatewaySaveInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export function createChannelGatewayHandlers(): Record<string, RpcHandler> {
  return {
    [CHANNEL_GATEWAY_IPC_CHANNELS.SIMULATE_INGRESS]: async (params) =>
      simulateChannelGatewayIngress(
        validateInput(
          channelGatewayIngressInputSchema,
          params,
          CHANNEL_GATEWAY_IPC_CHANNELS.SIMULATE_INGRESS
        ) as ChannelGatewayIngressInput
      ),
    [CHANNEL_GATEWAY_IPC_CHANNELS.LIST_BINDINGS]: async () => listChannelGatewayBindings(),
    [CHANNEL_GATEWAY_IPC_CHANNELS.UPSERT_BINDING]: async (params) =>
      upsertChannelGatewayBinding(
        validateInput(
          channelGatewayUpsertBindingInputSchema,
          params,
          CHANNEL_GATEWAY_IPC_CHANNELS.UPSERT_BINDING
        ) as {
          provider: ChannelProvider;
          externalChatId: string;
          externalUserId?: string;
          workspaceId?: string;
          sessionId: string;
        }
      ),
    [CHANNEL_GATEWAY_IPC_CHANNELS.LIST_DELIVERIES]: async (params) =>
      listChannelGatewayDeliveries(
        validateInput(
          channelGatewayListDeliveriesInputSchema,
          params ?? {},
          CHANNEL_GATEWAY_IPC_CHANNELS.LIST_DELIVERIES
        ) as ChannelGatewayListDeliveriesInput
      ),
    [CHANNEL_GATEWAY_IPC_CHANNELS.GET_INGRESS_STATUS]: async () => {
      const config = getFeishuGatewayConfig();
      return config.connectionMode === "websocket"
        ? getFeishuWsIngressStatus()
        : getFeishuIngressStatus();
    },
    [CHANNEL_GATEWAY_IPC_CHANNELS.START_INGRESS]: async () => {
      const config = getFeishuGatewayConfig();
      if (config.connectionMode === "websocket") {
        await stopFeishuIngressServer();
        return startFeishuWsIngressServer();
      }
      await stopFeishuWsIngressServer();
      return startFeishuIngressServer();
    },
    [CHANNEL_GATEWAY_IPC_CHANNELS.STOP_INGRESS]: async () => {
      await stopFeishuIngressServer();
      await stopFeishuWsIngressServer();
      return { ok: true };
    },
    [CHANNEL_GATEWAY_IPC_CHANNELS.GET_FEISHU_CONFIG]: async () => getFeishuGatewayConfigView(),
    [CHANNEL_GATEWAY_IPC_CHANNELS.SAVE_FEISHU_CONFIG]: async (params) =>
      saveFeishuGatewayConfig(
        validateInput(
          feishuGatewaySaveInputSchema,
          params,
          CHANNEL_GATEWAY_IPC_CHANNELS.SAVE_FEISHU_CONFIG
        )
      ),
    [CHANNEL_GATEWAY_IPC_CHANNELS.TEST_FEISHU_CONFIG]: async () => testFeishuGatewayConnection()
  };
}
