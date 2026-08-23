import { CONNECTOR_IPC_CHANNELS } from "@lume/shared";
import type { ConnectorStatus } from "@lume/shared";
import {
  disconnectConnector,
  getConnector,
  getConnectorConnectedAccountLabel,
  getConnectorSetup,
  hasAnyConnectorCredential,
  listConnectors,
  saveConnectorCustomCredential,
  startConnectorAuthorization,
} from "../services/connectors/service";
import {
  getConnectorClientConfig,
  setConnectorClientConfig,
} from "../services/connectors/credential-store";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";
import { z } from "zod";

const saveClientConfigSchema = z.object({
  service: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const saveCredentialSchema = z.object({
  service: z.string().min(1),
  values: z.record(z.string(), z.string()),
});

const serviceSchema = z.object({ service: z.string().min(1) });

/** 进行中的授权流 + 最近一次失败原因(UI 轮询 get-status 消费)。 */
interface ConnectorAuthState {
  authorizing: boolean;
  lastError?: string;
}
const authStates = new Map<string, ConnectorAuthState>();

function buildStatus(service: string): ConnectorStatus {
  const authState = authStates.get(service);
  return {
    service,
    clientConfigured: !!getConnectorClientConfig(service)?.clientId,
    connected: hasAnyConnectorCredential(service),
    accountLabel: getConnectorConnectedAccountLabel(service),
    authorizing: authState?.authorizing ?? false,
    lastError: authState?.lastError,
  };
}

function parseService(params: unknown, channel: string): string {
  const { service } = validateInput(serviceSchema, params, channel) as { service: string };
  getConnector(service); // 未注册的 service 直接抛错
  return service;
}

export function createConnectorHandlers(): Record<string, RpcHandler> {
  return {
    [CONNECTOR_IPC_CHANNELS.GET_STATUS]: async (params) => buildStatus(parseService(params, CONNECTOR_IPC_CHANNELS.GET_STATUS)),

    [CONNECTOR_IPC_CHANNELS.GET_SETUP]: async () =>
      listConnectors().map((service) => ({
        ...getConnectorSetup(service),
        ...buildStatus(service),
        service,
      })),

    [CONNECTOR_IPC_CHANNELS.SAVE_CLIENT_CONFIG]: async (params) => {
      const { service, clientId, clientSecret } = validateInput(
        saveClientConfigSchema,
        params,
        CONNECTOR_IPC_CHANNELS.SAVE_CLIENT_CONFIG,
      ) as { service: string; clientId: string; clientSecret: string };
      getConnector(service);
      setConnectorClientConfig(service, {
        service,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        extra: {},
        secretExtra: {},
      });
      return buildStatus(service);
    },

    [CONNECTOR_IPC_CHANNELS.SAVE_CREDENTIAL]: async (params) => {
      const { service, values } = validateInput(
        saveCredentialSchema,
        params,
        CONNECTOR_IPC_CHANNELS.SAVE_CREDENTIAL,
      ) as { service: string; values: Record<string, string> };
      // saveConnectorCustomCredential 内部跑连接测试,失败抛 ConnectorError 给 UI
      await saveConnectorCustomCredential(service, values);
      authStates.delete(service);
      return buildStatus(service);
    },

    [CONNECTOR_IPC_CHANNELS.START_AUTH]: async (params) => {
      const service = parseService(params, CONNECTOR_IPC_CHANNELS.START_AUTH);
      const flow = startConnectorAuthorization(service);
      authStates.set(service, { authorizing: true });
      void flow.done
        .then(() => {
          authStates.set(service, { authorizing: false });
        })
        .catch((error: unknown) => {
          authStates.set(service, {
            authorizing: false,
            lastError: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          // 保留 lastError 供 UI 展示;下次 START_AUTH 会覆盖
          setTimeout(() => {
            const state = authStates.get(service);
            if (state && !state.authorizing) authStates.delete(service);
          }, 60_000);
        });
      return { authorizationUrl: await flow.authorizationUrl, status: buildStatus(service) };
    },

    [CONNECTOR_IPC_CHANNELS.DISCONNECT]: async (params) => {
      const service = parseService(params, CONNECTOR_IPC_CHANNELS.DISCONNECT);
      disconnectConnector(service);
      authStates.delete(service);
      return buildStatus(service);
    },
  };
}
