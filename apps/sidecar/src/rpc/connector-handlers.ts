import { CONNECTOR_IPC_CHANNELS } from "@lume/shared";
import type { ConnectorStatus } from "@lume/shared";
import {
  ConnectorError,
  disconnectConnector,
  getConnector,
  getConnectorSetup,
  listConnectors,
  saveConnectorCustomCredential,
  startConnectorAuthorization,
} from "../services/connectors/service";
import {
  getConnectorCredentialRecord,
  setConnectorClientConfig,
} from "../services/connectors/credential-store";
import { imapPoolMetricsSnapshot } from "../services/connectors/mail/protocol";
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
/** 每服务授权流代际:完成回调写入 authStates 前校验自己仍是当前流。 */
const authGenerations = new Map<string, number>();

function buildStatus(service: string): ConnectorStatus {
  const authState = authStates.get(service);
  // 单次读盘解密组装全部字段(GET_SETUP 对每个服务各调一次,避免逐字段重复 IO)
  const record = getConnectorCredentialRecord(service);
  const { oauth, customValues } = record;
  // oauth2 型服务的 customValues 不算连接(与 hasAnyConnectorCredential 同口径:
  // 存量毒数据不得让 UI 显示已连接)
  const supportsCustomOnly = !getConnector(service).definition.authTypes.includes("oauth2");
  return {
    service,
    clientConfigured: !!record.clientConfig?.clientId,
    connected: oauth !== undefined || (supportsCustomOnly && customValues !== undefined),
    accountLabel: oauth ? oauth.profile?.displayName : supportsCustomOnly ? customValues?.email : undefined,
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
      // 授权码型凭证仅对 custom_credential 服务有意义;OAuth 型服务收到任意 values
      // 若照单全收会写入 customValues 使 buildStatus 显示假 connected。
      // 判定走 definition.auth 与 requireOAuthAuth 同源,避免依赖人工同步的 authTypes 快列表
      if (!getConnector(service).definition.auth.some((auth) => auth.type === "custom_credential")) {
        throw new ConnectorError("connector_auth_unsupported", `${service} 使用 OAuth 授权,无授权码凭证可保存`);
      }
      // saveConnectorCustomCredential 内部跑连接测试,失败抛 ConnectorError 给 UI
      await saveConnectorCustomCredential(service, values);
      authStates.delete(service);
      // 在途 OAuth 流的完成回调不得复活刚清理的状态(与 DISCONNECT 同款代际作废)
      authGenerations.set(service, (authGenerations.get(service) ?? 0) + 1);
      return buildStatus(service);
    },

    [CONNECTOR_IPC_CHANNELS.START_AUTH]: async (params) => {
      const service = parseService(params, CONNECTOR_IPC_CHANNELS.START_AUTH);
      // 代际号:supersede/disconnect 会 reject 旧流,旧流的完成回调晚于新流写入时
      // 必须作废,否则旧流把新流的 authorizing 覆盖成"异常"甚至整条删除
      const generation = (authGenerations.get(service) ?? 0) + 1;
      authGenerations.set(service, generation);
      const isCurrent = () => authGenerations.get(service) === generation;
      const flow = startConnectorAuthorization(service);
      authStates.set(service, { authorizing: true });
      void flow.done
        .then(() => {
          if (!isCurrent()) return;
          authStates.set(service, { authorizing: false });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          authStates.set(service, {
            authorizing: false,
            lastError: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (!isCurrent()) return;
          // 保留 lastError 供 UI 展示;下次 START_AUTH 会覆盖
          setTimeout(() => {
            const state = authStates.get(service);
            if (state && !state.authorizing && isCurrent()) authStates.delete(service);
          }, 60_000);
        });
      return { authorizationUrl: await flow.authorizationUrl, status: buildStatus(service) };
    },

    [CONNECTOR_IPC_CHANNELS.DISCONNECT]: async (params) => {
      const service = parseService(params, CONNECTOR_IPC_CHANNELS.DISCONNECT);
      // 递增代际作废在途回调:被拒流的 .catch 不得复活刚删除的错误态
      authGenerations.set(service, (authGenerations.get(service) ?? 0) + 1);
      disconnectConnector(service);
      authStates.delete(service);
      return buildStatus(service);
    },

    // 只读诊断出口(#790):进程级池指标计数器 + kind 细分,devtools/支持场景在线验证
    [CONNECTOR_IPC_CHANNELS.GET_POOL_METRICS]: async () => imapPoolMetricsSnapshot(),
  };
}
