import { CONNECTOR_IPC_CHANNELS } from "@lume/shared";
import type { ConnectorStatus } from "@lume/shared";
import {
  disconnectConnector,
  getConnector,
  startConnectorAuthorization,
} from "../services/connectors/service";
import {
  deleteConnectorCredential,
  getConnectorClientConfig,
  getConnectorOAuthCredential,
  setConnectorClientConfig,
} from "../services/connectors/credential-store";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";
import { z } from "zod";

const SERVICE = "gmail";

const saveClientConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const serviceSchema = z.object({ service: z.string().min(1) });

/** 进行中的授权流 + 最近一次失败原因(UI 轮询 get-status 消费)。 */
interface ConnectorAuthState {
  authorizing: boolean;
  lastError?: string;
}
const authStates = new Map<string, ConnectorAuthState>();

function buildStatus(service: string): ConnectorStatus {
  const credential = getConnectorOAuthCredential(service);
  const authState = authStates.get(service);
  return {
    service,
    clientConfigured: !!getConnectorClientConfig(service)?.clientId,
    connected: !!credential,
    accountLabel: credential?.profile?.displayName,
    authorizing: authState?.authorizing ?? false,
    lastError: authState?.lastError,
  };
}

export function createConnectorHandlers(): Record<string, RpcHandler> {
  return {
    [CONNECTOR_IPC_CHANNELS.GET_STATUS]: async (params) => {
      const { service } = validateInput(serviceSchema, params, CONNECTOR_IPC_CHANNELS.GET_STATUS) as {
        service: string;
      };
      getConnector(service); // 未注册的 service 直接抛错
      return buildStatus(service);
    },

    [CONNECTOR_IPC_CHANNELS.SAVE_CLIENT_CONFIG]: async (params) => {
      const payload = validateInput(
        saveClientConfigSchema,
        params,
        CONNECTOR_IPC_CHANNELS.SAVE_CLIENT_CONFIG,
      ) as { clientId: string; clientSecret: string };
      setConnectorClientConfig(SERVICE, {
        service: SERVICE,
        clientId: payload.clientId.trim(),
        clientSecret: payload.clientSecret.trim(),
        extra: {},
        secretExtra: {},
      });
      return buildStatus(SERVICE);
    },

    [CONNECTOR_IPC_CHANNELS.START_AUTH]: async (params) => {
      const { service } = validateInput(serviceSchema, params, CONNECTOR_IPC_CHANNELS.START_AUTH) as {
        service: string;
      };
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
      const { service } = validateInput(serviceSchema, params, CONNECTOR_IPC_CHANNELS.DISCONNECT) as {
        service: string;
      };
      disconnectConnector(service);
      authStates.delete(service);
      return buildStatus(service);
    },
  };
}
